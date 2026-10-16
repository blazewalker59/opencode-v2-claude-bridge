import { statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute } from "node:path"
import { Model, type Plugin, Provider } from "@opencode/plugin"
import { type Options, query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  adaptiveThinkingModels,
  type BridgeModel,
  discoveredCatalog,
  discoverModels,
  fallbackCatalog,
  PROVIDER_ID,
  toCatalog,
} from "./models.js"
import { type BridgeLog, startBridgeServer, TOKEN_HEADER } from "./bridge-server.js"
import { openDebugLog } from "./debug-log.js"
import { readInstructions } from "./instructions.js"
import {
  forgetDeletedSessions,
  isSessionState,
  KIND_HEADER,
  SESSION_HEADER,
  type SessionStore,
  sweepDeletedSessions,
} from "./sessions.js"
import { gatewayVariablesSet } from "./diagnostics.js"
import { type BridgePluginOptions, parsePluginOptions, resolveWorkingDirectory } from "./options.js"

/** The parts of OpenCode's plugin context the bridge uses. */
export type SetupContext = Pick<Plugin.Context, "options" | "location" | "storage" | "session" | "event" | "provider">

/** Injectable for offline tests; production uses the real Agent SDK, filesystem, environment and console. */
export type SetupDependencies = {
  query?: (prompt: AsyncIterable<SDKUserMessage>, options: Options) => Pick<Query, "supportedModels" | "close">
  isDirectory?: (path: string) => boolean
  env?: NodeJS.ProcessEnv
  /** Home directory, where the global instruction files live. */
  home?: string
  /** Problems worth telling the user about that should not stop the plugin from loading. */
  warn?: (message: string) => void
}

type Registration = { dispose: () => Promise<void> }

const DEBUG_LOG_VARIABLE = "OPENCODE_CLAUDE_BRIDGE_DEBUG_LOG"

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The debug log. A path set in the plugin options is part of this plugin's
 * configuration, so a bad one stops the plugin from loading, naming it. The
 * environment variable may be inherited from a shell profile into every
 * OpenCode launch, so a bad value there only produces a warning: the plugin
 * loads without a log.
 */
const openLog = (options: BridgePluginOptions, env: NodeJS.ProcessEnv, warn: (message: string) => void): BridgeLog | undefined => {
  if (options.debugLog) return openDebugLog(options.debugLog)
  const fromEnv = env[DEBUG_LOG_VARIABLE]
  if (!fromEnv) return undefined
  if (!isAbsolute(fromEnv)) {
    warn(`opencode-v2-claude-bridge: ${DEBUG_LOG_VARIABLE} must be an absolute path; the debug log is off.`)
    return undefined
  }
  try {
    return openDebugLog(fromEnv)
  } catch (error) {
    warn(`opencode-v2-claude-bridge: ${message(error)}; the debug log is off.`)
    return undefined
  }
}

type Storage = SetupContext["storage"]

const SESSION_KEY_PREFIX = "session/"

/** OpenCode session IDs that have stored state, read page by page, until the plugin unloads. */
async function* storedSessionIds(storage: Storage, signal: AbortSignal): AsyncGenerator<string> {
  let after: string | undefined
  do {
    if (signal.aborted) return
    const page = await storage.scan({ prefix: SESSION_KEY_PREFIX, after, limit: 100 })
    for (const entry of page.entries) {
      if (signal.aborted) return
      yield entry.key.slice(SESSION_KEY_PREFIX.length)
    }
    after = page.next
  } while (after)
}

/** False only when OpenCode reports the session does not exist; undefined when the lookup was inconclusive. */
const sessionExists =
  (session: SetupContext["session"], log: BridgeLog | undefined) =>
  (sessionID: string): Promise<boolean | undefined> =>
    session.get({ sessionID }).then(
      () => true,
      (error: unknown) => {
        const { _tag, name } = (error ?? {}) as { _tag?: unknown; name?: unknown }
        // The in-process plugin API and the HTTP API spell the same error differently.
        if (_tag === "Session.NotFoundError" || _tag === "SessionNotFoundError") return false
        log?.("session.lookup", { session: sessionID, outcome: "inconclusive", tag: _tag ?? null, name: name ?? null })
        return undefined
      },
    )

/** Session state in OpenCode's plugin storage, so sessions resume across OpenCode restarts. */
const pluginSessionStore = (storage: Storage): SessionStore => {
  const key = (id: string) => `${SESSION_KEY_PREFIX}${id}`
  return {
    get: async (id) => {
      const value = await storage.get(key(id))
      return isSessionState(value) ? value : undefined
    },
    set: (id, state) => storage.set(key(id), state),
    remove: (id) => storage.remove(key(id)),
  }
}

/**
 * Start the bridge for one OpenCode project and register its provider.
 * Returns the cleanup OpenCode calls when it unloads the plugin. If any step
 * fails, everything already started is shut down before the error is
 * rethrown, so a failed load leaves no adapter listening.
 */
export const setupBridge = async (context: SetupContext, dependencies: SetupDependencies = {}): Promise<() => Promise<void>> => {
  const env = dependencies.env ?? process.env
  const warn = dependencies.warn ?? ((text: string) => console.warn(text))
  const startQuery = dependencies.query ?? ((prompt, queryOptions) => query({ prompt, options: queryOptions }))

  const options = parsePluginOptions(context.options)
  const log = openLog(options, env, warn)
  const cwd = resolveWorkingDirectory(context.location.directory, options.workingDirectory, dependencies.isDirectory ?? isDirectory)
  if (cwd !== context.location.directory) log?.("config.workingDirectory", { project: context.location.directory, workingDirectory: cwd })
  const gateway = gatewayVariablesSet(env)
  if (gateway.length > 0) log?.("config.gateway", { variables: gateway })
  const sessions = pluginSessionStore(context.storage)
  // Filled by discovery; until then the Agent SDK's thinking defaults are left alone.
  let thinkingModels = new Set<string>()
  let markDiscovered: () => void = () => {}
  const discoveryDone = new Promise<void>((resolve) => (markDiscovered = resolve))
  const bridge = await startBridgeServer({
    cwd,
    log,
    toolPolicy: options.toolPolicy,
    sessions,
    titleModel: options.titleModel,
    claudeExecutable: options.claudeExecutable,
    // Found from the OpenCode project, as OpenCode finds them, whatever directory Claude Code runs in.
    instructions: () => readInstructions(context.location.directory, dependencies.home ?? homedir(), env),
    // The first request can arrive before discovery answers; wait briefly for it.
    summarizedThinking: async (model) => {
      await Promise.race([discoveryDone, new Promise((resolve) => setTimeout(resolve, 2_000).unref())])
      return thinkingModels.has(model)
    },
  })

  // Everything set up from here is undone if a later step fails, or when the plugin unloads.
  const unload = new AbortController()
  let sessionHeaders: Registration | undefined
  let providerRegistration: Registration | undefined
  let tornDown: Promise<void> | undefined
  // Each step runs even if an earlier one fails, so the adapter always closes; safe to call twice.
  const teardown = () =>
    (tornDown ??= (async () => {
      unload.abort()
      try {
        await sessionHeaders?.dispose()
      } finally {
        try {
          await providerRegistration?.dispose()
        } finally {
          await bridge.close()
        }
      }
    })())

  try {
    // Forget the mapping when OpenCode deletes a session.
    const forgetFailed = (id: string, error: unknown) => log?.("session.error", { session: id, message: message(error) })
    forgetDeletedSessions(
      context.event.subscribe({ signal: unload.signal }),
      sessions,
      (id) => log?.("session.forget", { session: id }),
      forgetFailed,
    ).catch((error: unknown) => {
      if (!unload.signal.aborted) log?.("session.error", { message: message(error) })
    })
    // And catch up on sessions deleted while the bridge was not listening.
    sweepDeletedSessions(
      storedSessionIds(context.storage, unload.signal),
      sessionExists(context.session, log),
      sessions,
      (id) => log?.("session.forget", { session: id, sweep: true }),
      forgetFailed,
    ).catch((error: unknown) => {
      if (!unload.signal.aborted) log?.("session.error", { message: message(error) })
    })
    const providerID = Provider.ID.make(PROVIDER_ID)

    // Tell the bridge which OpenCode session (and kind of request) each model call serves, and
    // prove the request comes from this OpenCode. The hook only runs for this provider's requests.
    sessionHeaders = await context.session.hook(
      "model.request",
      (request) => {
        request.headers[TOKEN_HEADER] = bridge.token
        request.headers[SESSION_HEADER] = request.sessionID
        request.headers[KIND_HEADER] = request.kind
      },
      { providerID: PROVIDER_ID },
    )

    // Start with the fallback catalog so the provider appears immediately, then
    // replace it with the models Claude Code reports for this account.
    let catalog: BridgeModel[] = fallbackCatalog(options.models)
    providerRegistration = await context.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Claude Agent SDK",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${bridge.port}/v1` },
        },
        models: catalog.map((model) => ({
          ...Model.Info.default(providerID, Model.ID.make(model.id)),
          name: model.name,
          limit: { context: model.context, input: model.context, output: model.output },
          capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
          // One variant per effort level Claude Code reports for the model; the bridge reads
          // `reasoning_effort` from the request and passes it to the Agent SDK as `effort`.
          variants: (model.efforts ?? []).map((level) => ({ id: Model.VariantID.make(level), body: { reasoning_effort: level } })),
        })),
      })
    })

    discoverModels({ cwd, pathToClaudeCodeExecutable: options.claudeExecutable }, startQuery, undefined, unload.signal)
      .then(
        async (models) => {
          if (unload.signal.aborted) return
          thinkingModels = adaptiveThinkingModels(models)
          const reported = toCatalog(models)
          const discovered = discoveredCatalog(reported, options.models)
          log?.("models.discovered", { models: discovered.map((model) => model.id) })
          // Allowlisted IDs Claude Code does not list stay offered (a full model ID works), but a
          // typo would too, so name them; using one fails with an "unknown model" hint.
          const unlisted = (options.models ?? []).filter((id) => !reported.some((model) => model.id === id))
          if (unlisted.length > 0) log?.("models.unlisted", { models: unlisted })
          if (discovered.length === 0) return
          catalog = discovered
          await context.provider.reload().catch((error: unknown) => log?.("models.reload_failed", { message: message(error) }))
        },
        (error: unknown) => {
          if (!unload.signal.aborted) log?.("models.fallback", { message: message(error) })
        },
      )
      // An unexpected model list (a field missing, say) must not become an unhandled rejection.
      .catch((error: unknown) => log?.("models.error", { message: message(error) }))
      .finally(() => markDiscovered())
  } catch (error) {
    await teardown().catch(() => {})
    throw error
  }

  return teardown
}
