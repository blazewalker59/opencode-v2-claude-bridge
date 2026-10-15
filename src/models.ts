import type { ModelInfo, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

export const PROVIDER_ID = "claude-agent-sdk"

export type BridgeModel = {
  /** Model ID OpenCode uses and the bridge passes to the Agent SDK (an alias such as `sonnet`, or a full ID). */
  id: string
  name: string
  context: number
  output: number
}

const DEFAULT_CONTEXT = 200_000
const LONG_CONTEXT = 1_000_000
const DEFAULT_OUTPUT = 64_000

/**
 * Used until discovery finishes, or when it fails. Claude Code's aliases
 * always resolve to the current model of each family, so this list does not
 * go stale the way pinned model IDs do.
 */
export const FALLBACK_MODELS: readonly BridgeModel[] = [
  { id: "opus", name: "Claude Opus (Agent SDK)", context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
  { id: "sonnet", name: "Claude Sonnet (Agent SDK)", context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
  { id: "haiku", name: "Claude Haiku (Agent SDK)", context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
]

/**
 * Turn Claude Code's model list into the provider's catalog. The `default`
 * row duplicates another alias, so it is dropped; a `[1m]` suffix marks a
 * 1M-token context window. The descriptions name the concrete model the
 * alias currently resolves to, so they are kept in the display name.
 */
export const toCatalog = (models: readonly ModelInfo[]): BridgeModel[] => {
  const seen = new Set<string>()
  return models
    .filter((model) => model.value !== "default")
    .filter((model) => !seen.has(model.value) && seen.add(model.value))
    .map((model) => {
      const resolved = model.description.split("·")[0]?.trim()
      return {
        id: model.value,
        name: `Claude ${model.displayName}${resolved && resolved !== model.displayName ? ` · ${resolved}` : ""} (Agent SDK)`,
        context: /\[1m\]$/i.test(model.resolvedModel ?? model.value) ? LONG_CONTEXT : DEFAULT_CONTEXT,
        output: DEFAULT_OUTPUT,
      }
    })
}


/**
 * The catalog before discovery answers, or when it fails or matches nothing.
 * With an allowlist, each allowlisted ID is offered, using the built-in entry
 * where there is one, so an allowlist of full model IDs (which Claude Code
 * accepts but does not list) never leaves the model picker empty.
 */
export const fallbackCatalog = (allow: readonly string[] | undefined): BridgeModel[] =>
  allow
    ? allow.map(
        (id) =>
          FALLBACK_MODELS.find((model) => model.id === id) ?? {
            id,
            name: `Claude ${id} (Agent SDK)`,
            context: /\[1m\]$/i.test(id) ? LONG_CONTEXT : DEFAULT_CONTEXT,
            output: DEFAULT_OUTPUT,
          },
      )
    : [...FALLBACK_MODELS]

/**
 * The catalog once discovery answers. Without an allowlist it is what Claude
 * Code reports. With one, it is the allowlist, in its order, using Claude
 * Code's details for the models it reports and keeping the IDs it does not.
 */
export const discoveredCatalog = (discovered: readonly BridgeModel[], allow: readonly string[] | undefined): BridgeModel[] =>
  allow
    ? fallbackCatalog(allow).map((model) => discovered.find((entry) => entry.id === model.id) ?? model)
    : [...discovered]

/**
 * Ask Claude Code which models this account can use. Quota-free: the query's
 * input never yields a message, so only Claude Code's startup handshake runs.
 */
export const discoverModels = async (
  options: Pick<Options, "cwd" | "pathToClaudeCodeExecutable">,
  start: (prompt: AsyncIterable<SDKUserMessage>, options: Options) => Pick<Query, "supportedModels" | "close">,
  timeoutMs = 20_000,
  /** Aborted when the plugin unloads; discovery then stops and its query closes. */
  signal?: AbortSignal,
): Promise<ModelInfo[]> => {
  const silent: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      await new Promise<never>(() => {})
    },
  }
  // The same lockdown as a turn: no settings, no tools, and no MCP servers (strict mode
  // ignores the user's), so discovery starts nothing but Claude Code itself.
  const query = start(silent, { ...options, settingSources: [], persistSession: false, tools: [], mcpServers: {}, strictMcpConfig: true })
  let timer: NodeJS.Timeout | undefined
  let onAbort: () => void = () => {}
  try {
    return await Promise.race([
      query.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Claude Code did not report its models within ${timeoutMs} ms`)), timeoutMs)
        onAbort = () => reject(new Error("Model discovery was cancelled"))
        if (signal?.aborted) onAbort()
        else signal?.addEventListener("abort", onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
    query.close()
  }
}

/** Model IDs that Claude Code reports support adaptive thinking. */
export const adaptiveThinkingModels = (models: readonly ModelInfo[]): Set<string> =>
  new Set(models.filter((model) => model.supportsAdaptiveThinking === true).map((model) => model.value))
