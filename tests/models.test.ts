import assert from "node:assert/strict"
import test from "node:test"
import type { ModelInfo, Options } from "@anthropic-ai/claude-agent-sdk"
import { adaptiveThinkingModels, discoveredCatalog, discoverModels, FALLBACK_MODELS, fallbackCatalog, toCatalog } from "../src/models.js"

// Captured from Claude Code's supportedModels() on a real account (quota-free probe).
const DISCOVERED: ModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1[1m]", displayName: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", description: "Sonnet 5.5 · Efficient for routine tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "Haiku 5.5 · Fastest for quick answers" },
]

test("discovered models become the catalog, without the duplicate default row", () => {
  const catalog = toCatalog(DISCOVERED)
  assert.deepEqual(
    catalog.map((model) => [model.id, model.name, model.context]),
    [
      ["opus", "Claude Opus · Opus 5.5 (Agent SDK)", 200_000],
      ["claude-fable-5-1[1m]", "Claude Fable · Fable 5.1 (Agent SDK)", 1_000_000],
      ["sonnet", "Claude Sonnet · Sonnet 5.5 (Agent SDK)", 200_000],
      ["haiku", "Claude Haiku · Haiku 5.5 (Agent SDK)", 200_000],
    ],
  )
})

test("the fallback catalog uses aliases that never go stale", () => {
  assert.deepEqual(
    FALLBACK_MODELS.map((model) => model.id),
    ["opus", "sonnet", "haiku"],
  )
})

test("an allowlist narrows the catalog, in its own order, and keeps IDs Claude Code does not list", () => {
  assert.deepEqual(
    discoveredCatalog(toCatalog(DISCOVERED), ["haiku", "sonnet"]).map((model) => [model.id, model.name]),
    [
      ["haiku", "Claude Haiku · Haiku 5.5 (Agent SDK)"],
      ["sonnet", "Claude Sonnet · Sonnet 5.5 (Agent SDK)"],
    ],
  )
  assert.deepEqual(
    discoveredCatalog(toCatalog(DISCOVERED), ["claude-sonnet-4-6"]).map((model) => model.id),
    ["claude-sonnet-4-6"],
    "a full model ID stays offered",
  )
  assert.equal(discoveredCatalog(toCatalog(DISCOVERED), undefined).length, 4)
})

test("discovery never sends a message, keeps nothing on disk, and always closes the query", async () => {
  let seen: Options | undefined
  let closed = 0
  let sent = false
  const models = await discoverModels({ cwd: "/work", pathToClaudeCodeExecutable: "/opt/claude" }, (prompt, options) => {
    seen = options
    void (async () => {
      for await (const _ of prompt) sent = true
    })()
    return { supportedModels: async () => DISCOVERED, close: () => void closed++ }
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(models.length, 5)
  assert.equal(sent, false, "the input iterable never yields a message")
  assert.equal(closed, 1)
  assert.deepEqual(seen, {
    cwd: "/work",
    pathToClaudeCodeExecutable: "/opt/claude",
    settingSources: ["user"],
    persistSession: false,
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
  })
})

test("discovery times out and still closes the query", async () => {
  let closed = 0
  await assert.rejects(
    discoverModels({ cwd: "/work" }, () => ({ supportedModels: () => new Promise(() => {}), close: () => void closed++ }), 30),
    /did not report its models within 30 ms/,
  )
  assert.equal(closed, 1)
})

test("adaptive-thinking support comes from discovery", () => {
  const models = [
    { value: "sonnet", displayName: "Sonnet", description: "", supportsAdaptiveThinking: true },
    { value: "legacy", displayName: "Legacy", description: "" },
  ]
  assert.deepEqual([...adaptiveThinkingModels(models)], ["sonnet"])
})

test("before discovery, an allowlist offers each allowlisted ID, so the picker is never empty", () => {
  assert.deepEqual(fallbackCatalog(undefined), [...FALLBACK_MODELS])
  assert.deepEqual(
    fallbackCatalog(["sonnet", "claude-sonnet-4-6", "claude-opus-4-7[1m]"]).map((model) => [model.id, model.name, model.context]),
    [
      ["sonnet", "Claude Sonnet (Agent SDK)", 200_000],
      ["claude-sonnet-4-6", "Claude claude-sonnet-4-6 (Agent SDK)", 200_000],
      ["claude-opus-4-7[1m]", "Claude claude-opus-4-7[1m] (Agent SDK)", 1_000_000],
    ],
  )
})

test("unloading the plugin cancels discovery and closes the query", async () => {
  let closed = 0
  const unload = new AbortController()
  const discovery = discoverModels({ cwd: "/work" }, () => ({ supportedModels: () => new Promise(() => {}), close: () => void closed++ }), 60_000, unload.signal)
  unload.abort()
  await assert.rejects(discovery, /cancelled/)
  assert.equal(closed, 1)
})
