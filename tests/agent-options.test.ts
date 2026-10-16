import assert from "node:assert/strict"
import test from "node:test"
import { agentOptions } from "../src/bridge-server.js"
import { convertTools, createToolServer, PendingToolCalls } from "../src/tool-bridge.js"

const AGENT = { type: "claude-code" } as const

const fn = (name: string) => ({ type: "function", function: { name } })

const forbiddenPosture = (options: ReturnType<typeof agentOptions>) => {
  assert.ok(!("allowDangerouslySkipPermissions" in options), "never sets allowDangerouslySkipPermissions")
  assert.ok(!["bypassPermissions", "acceptEdits", "auto"].includes(options.permissionMode ?? ""))
  assert.equal(options.canUseTool, undefined, "no callback silently approves calls")
}

test("with OpenCode tools, Claude gets only the bridged tools and nothing auto-approved beyond them", () => {
  const { tools } = convertTools([fn("read"), fn("shell"), fn("edit")], "opencode")
  const toolServer = createToolServer(tools, new PendingToolCalls())
  const allowedTools = tools.map((tool) => tool.qualifiedName)
  const options = agentOptions("/work", { model: "m", abortController: new AbortController(), toolServer, allowedTools, persistSession: true, system: AGENT })

  forbiddenPosture(options)
  assert.deepEqual(options.tools, [], "built-in Claude Code tools are removed")
  assert.equal(options.permissionMode, "dontAsk", "anything not allowlisted is denied, never prompted")
  assert.deepEqual(options.allowedTools, ["mcp__opencode__read", "mcp__opencode__shell", "mcp__opencode__edit"])
  assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["opencode"])
  assert.equal(options.strictMcpConfig, true, "user MCP configs are ignored")
  assert.deepEqual(options.settingSources, ["user"], "only the user's own settings: a repository cannot add hooks or allow rules")
})

test("without OpenCode tools, Claude answers in text only: nothing runs outside OpenCode", () => {
  const options = agentOptions("/work", { model: "m", abortController: new AbortController(), allowedTools: ["Read"], persistSession: true, system: AGENT })
  forbiddenPosture(options)
  assert.deepEqual(options.tools, [], "no built-in Claude Code tools, not even read-only ones")
  assert.deepEqual(options.allowedTools, [], "nothing is allowed without a bridged tool server")
  assert.equal(options.permissionMode, "dontAsk")
  assert.deepEqual(options.mcpServers, {})
  assert.equal(options.strictMcpConfig, true, "user MCP configs are ignored")
  assert.deepEqual(options.settingSources, ["user"])
})

test("session fields map onto the public Agent SDK options", () => {
  const base = { model: "m", abortController: new AbortController(), allowedTools: [], system: AGENT }
  const fresh = agentOptions("/work", { ...base, sessionId: "11111111-1111-4111-8111-111111111111", persistSession: true })
  assert.equal(fresh.sessionId, "11111111-1111-4111-8111-111111111111")
  assert.equal(fresh.resume, undefined)
  assert.equal(fresh.persistSession, true)

  const resumed = agentOptions("/work", { ...base, resume: "sdk-1", sessionId: "ignored", persistSession: true })
  assert.equal(resumed.resume, "sdk-1")
  assert.equal(resumed.sessionId, undefined, "sessionId cannot be combined with resume")

  const throwaway = agentOptions("/work", { ...base, persistSession: false })
  assert.equal(throwaway.persistSession, false)
  assert.equal(throwaway.sessionId, undefined)
})

test("agent turns run on Claude Code's own prompt; task requests keep their task prompt", () => {
  const base = { model: "m", abortController: new AbortController(), allowedTools: [], persistSession: true }
  const agent = agentOptions("/work", { ...base, system: { type: "claude-code", append: "Use tabs." } })
  assert.deepEqual(agent.systemPrompt, { type: "preset", preset: "claude_code", append: "Use tabs.", snapshot: false })

  const resumed = agentOptions("/work", { ...base, resume: "sdk-1", system: AGENT })
  assert.deepEqual(
    resumed.systemPrompt,
    { type: "preset", preset: "claude_code", snapshot: false },
    "sent on resumed turns too: without it the Agent SDK falls back to a minimal prompt",
  )

  const task = agentOptions("/work", { ...base, persistSession: false, system: { type: "task", text: "Write a title." } })
  assert.deepEqual(task.systemPrompt, { type: "custom", prompt: "Write a title.", snapshot: false })
  assert.deepEqual(task.settingSources, ["user"], "both kinds load only the user's settings")
})

test("a configured Claude Code executable is passed to the Agent SDK", () => {
  const base = { model: "m", abortController: new AbortController(), allowedTools: [], persistSession: false, system: AGENT }
  assert.equal(agentOptions("/work", base, "/opt/claude/bin/claude").pathToClaudeCodeExecutable, "/opt/claude/bin/claude")
  assert.equal("pathToClaudeCodeExecutable" in agentOptions("/work", base), false)
})

test("summarized thinking is requested only when the bridge knows the model supports it", () => {
  const base = { model: "sonnet", abortController: new AbortController(), allowedTools: [], persistSession: false, system: AGENT }
  assert.deepEqual(agentOptions("/work", { ...base, showThinking: true }).thinking, { type: "adaptive", display: "summarized" })
  assert.equal(agentOptions("/work", base).thinking, undefined, "otherwise the Agent SDK default is left alone")
})

test("every query keeps the git snapshot out of the prompt and skips claude.ai connectors", () => {
  const base = { model: "m", abortController: new AbortController(), allowedTools: [], persistSession: false }
  for (const system of [AGENT, { type: "task", text: "Write a title." } as const]) {
    const options = agentOptions("/work", { ...base, system })
    assert.deepEqual(options.settings, { includeGitInstructions: false }, "a commit must not rewrite the cached prompt")
    assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "0", "claude.ai connectors are never fetched")
    assert.equal(options.env?.DISABLE_AUTO_COMPACT, "1", "OpenCode compacts the conversation, never Claude Code behind its back")
    assert.equal(options.env?.PATH, process.env.PATH, "the Agent SDK replaces the environment, so the inherited one is copied")
  }
})

test("a reasoning effort reaches the Agent SDK only when one was chosen", () => {
  const base = { model: "m", abortController: new AbortController(), allowedTools: [], persistSession: false, system: AGENT }
  assert.equal(agentOptions("/work", { ...base, effort: "high" }).effort, "high")
  assert.equal("effort" in agentOptions("/work", base), false, "otherwise Claude Code's default applies")
})

test("Claude Code's own debug log is written only when a file is given", () => {
  const base = { model: "m", abortController: new AbortController(), allowedTools: [], persistSession: false, system: AGENT }
  const on = agentOptions("/work", { ...base, debugFile: "/logs/q.log" })
  assert.deepEqual([on.debug, on.debugFile], [true, "/logs/q.log"])
  const off = agentOptions("/work", base)
  assert.equal("debug" in off || "debugFile" in off, false)
})
