import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk"
import { TOKEN_HEADER } from "../src/bridge-server.js"
import { type SetupContext, type SetupDependencies, setupBridge } from "../src/plugin-setup.js"
import { KIND_HEADER, SESSION_HEADER } from "../src/sessions.js"
import { deferred } from "./helpers/fake-agent.js"

const MODELS: ModelInfo[] = [
  { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5.5 · Efficient" },
  { value: "haiku", displayName: "Haiku", description: "Haiku 5.5 · Fast" },
]

type ModelRequest = { headers: Record<string, string>; sessionID: string; kind: string }

/**
 * A stand-in for OpenCode's plugin context that records what the bridge
 * registers. `claudeExecutable` points at a missing file, so a turn that
 * reaches the Agent SDK fails before anything leaves the machine.
 */
const fakeOpenCode = (options: Record<string, unknown> = {}, overrides: { hookDispose?: () => Promise<void>; transformFails?: boolean } = {}) => {
  const hooks: Array<(request: ModelRequest) => void> = []
  const disposed: string[] = []
  const added: Array<{ info: { settings: { baseURL: string } }; models: Array<{ id: string; name: string; variants?: Array<{ id: string; body?: Record<string, unknown> }> }> }> = []
  const transforms: Array<(editor: unknown) => void> = []
  const editor = { add: (input: (typeof added)[number]) => added.push(input) }
  let reloads = 0
  const context = {
    options: { claudeExecutable: "/nonexistent/claude", ...options },
    location: { directory: process.cwd() },
    storage: {
      scan: async () => ({ entries: [], next: undefined }),
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    },
    session: {
      get: async () => ({}),
      hook: async (_name: string, callback: (request: ModelRequest) => void) => {
        hooks.push(callback)
        return { dispose: overrides.hookDispose ?? (async () => void disposed.push("hook")) }
      },
    },
    event: { subscribe: () => (async function* () {})() },
    provider: {
      transform: async (callback: (editor: unknown) => void) => {
        callback(editor)
        if (overrides.transformFails) throw new Error("provider registry unavailable")
        transforms.push(callback)
        return { dispose: async () => void disposed.push("provider") }
      },
      // As OpenCode does: a reload runs every registered transform again.
      reload: async () => {
        reloads++
        for (const transform of transforms) transform(editor)
      },
    },
  } as unknown as SetupContext
  return {
    context,
    hooks,
    disposed,
    get reloads() {
      return reloads
    },
    get port() {
      return Number(new URL(added[0]!.info.settings.baseURL).port)
    },
    get models() {
      return added.at(-1)!.models.map((model) => [String(model.id), model.name])
    },
    get variants() {
      return Object.fromEntries(added.at(-1)!.models.map((model) => [String(model.id), model.variants ?? []]))
    },
  }
}

const quietDiscovery = (models: Promise<ModelInfo[]>, closed: { count: number } = { count: 0 }): SetupDependencies => ({
  query: () => ({ supportedModels: () => models, close: () => void closed.count++ }),
  env: {},
  warn: () => {},
})

const reachable = (port: number) =>
  fetch(`http://127.0.0.1:${port}/health`).then(
    () => true,
    () => false,
  )

test("OpenCode's requests carry the token through the hook, and nothing else gets in", async () => {
  const openCode = fakeOpenCode()
  const teardown = await setupBridge(openCode.context, quietDiscovery(Promise.resolve(MODELS)))
  try {
    const request: ModelRequest = { headers: {}, sessionID: "ses_1", kind: "primary" }
    for (const hook of openCode.hooks) hook(request)
    assert.ok((request.headers[TOKEN_HEADER] ?? "").length >= 32)
    assert.equal(request.headers[SESSION_HEADER], "ses_1")
    assert.equal(request.headers[KIND_HEADER], "primary")

    const url = `http://127.0.0.1:${openCode.port}/v1/chat/completions`
    const body = JSON.stringify({ model: "sonnet", stream: true, messages: [{ role: "user", content: "Hi" }] })
    const without = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })
    assert.equal(without.status, 401)
    // With OpenCode's headers the turn runs, and fails at the missing executable before any request leaves.
    const withHook = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...request.headers }, body })
    assert.equal(withHook.status, 200)
    assert.match(await withHook.text(), /\/nonexistent\/claude/)
  } finally {
    await teardown()
  }
})

test("a setup step that fails shuts down everything already started", async () => {
  const openCode = fakeOpenCode({}, { transformFails: true })
  await assert.rejects(setupBridge(openCode.context, quietDiscovery(new Promise(() => {}))), /provider registry unavailable/)
  assert.deepEqual(openCode.disposed, ["hook"])
  assert.equal(await reachable(openCode.port), false, "no adapter left listening")
})

test("teardown closes the adapter even if disposing the hook fails, and is safe to call twice", async () => {
  const openCode = fakeOpenCode({}, { hookDispose: async () => Promise.reject(new Error("host already gone")) })
  const teardown = await setupBridge(openCode.context, quietDiscovery(Promise.resolve(MODELS)))
  assert.equal(await reachable(openCode.port), true)
  await assert.rejects(teardown(), /host already gone/)
  await assert.rejects(teardown(), /host already gone/, "the second call waits for the same teardown")
  assert.deepEqual(openCode.disposed, ["provider"])
  assert.equal(await reachable(openCode.port), false)
})

test("unloading during discovery closes its query and never reloads the provider", async () => {
  const openCode = fakeOpenCode()
  const closed = { count: 0 }
  const models = deferred<ModelInfo[]>()
  const teardown = await setupBridge(openCode.context, quietDiscovery(models.promise, closed))
  await teardown()
  models.resolve(MODELS)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(closed.count, 1)
  assert.equal(openCode.reloads, 0)
})

test("discovery replaces the catalog and names allowlisted IDs Claude Code does not list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocb-setup-"))
  try {
    const debugLog = join(dir, "bridge.log")
    const openCode = fakeOpenCode({ models: ["sonnet", "sonet"], debugLog })
    const teardown = await setupBridge(openCode.context, quietDiscovery(Promise.resolve(MODELS)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await teardown()
    assert.equal(openCode.reloads, 1)
    // The reloaded provider lists the allowlist, in order, with Claude Code's details where it has them.
    assert.deepEqual(openCode.models, [
      ["sonnet", "Claude Sonnet · Sonnet 5.5 (Agent SDK)"],
      ["sonet", "Claude sonet (Agent SDK)"],
    ])
    const events = readFileSync(debugLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; models?: string[] })
    assert.deepEqual(events.find((entry) => entry.event === "models.unlisted")?.models, ["sonet"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unexpected model list is logged, not left as an unhandled rejection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocb-setup-"))
  try {
    const debugLog = join(dir, "bridge.log")
    const openCode = fakeOpenCode({ debugLog })
    const malformed = [{ value: "sonnet", displayName: "Sonnet" }] as unknown as ModelInfo[]
    const teardown = await setupBridge(openCode.context, quietDiscovery(Promise.resolve(malformed)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await teardown()
    assert.match(readFileSync(debugLog, "utf8"), /"event":"models.error"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a bad debug-log variable only warns, but a bad debugLog option stops the plugin", async () => {
  const warnings: string[] = []
  for (const value of ["relative/bridge.log", "/nonexistent-dir/bridge.log"]) {
    const openCode = fakeOpenCode()
    const teardown = await setupBridge(openCode.context, {
      ...quietDiscovery(Promise.resolve(MODELS)),
      env: { OPENCODE_CLAUDE_BRIDGE_DEBUG_LOG: value },
      warn: (text) => void warnings.push(text),
    })
    await teardown()
  }
  assert.match(warnings[0] ?? "", /must be an absolute path; the debug log is off/)
  assert.match(warnings[1] ?? "", /Cannot write the debug log at \/nonexistent-dir\/bridge\.log/)
  await assert.rejects(
    setupBridge(fakeOpenCode({ debugLog: "/nonexistent-dir/bridge.log" }).context, quietDiscovery(Promise.resolve(MODELS))),
    /Cannot write the debug log/,
  )
})

test("each effort level Claude Code reports for a model becomes an OpenCode variant that sets reasoning_effort", async () => {
  const openCode = fakeOpenCode()
  const models: ModelInfo[] = [
    { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
    { value: "haiku", displayName: "Haiku", description: "Haiku 5.5" },
  ]
  const teardown = await setupBridge(openCode.context, quietDiscovery(Promise.resolve(models)))
  await new Promise((resolve) => setTimeout(resolve, 20))
  await teardown()
  assert.deepEqual(openCode.variants.sonnet, [
    { id: "low", body: { reasoning_effort: "low" } },
    { id: "medium", body: { reasoning_effort: "medium" } },
    { id: "high", body: { reasoning_effort: "high" } },
  ])
  assert.deepEqual(openCode.variants.haiku, [], "no variants for a model without effort levels")
})
