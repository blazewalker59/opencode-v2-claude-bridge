import assert from "node:assert/strict"
import test from "node:test"
import { agentOptions } from "../src/bridge-server.js"
import { convertTools, createToolServer, PendingToolCalls } from "../src/tool-bridge.js"

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
  const options = agentOptions("/work", { model: "m", abortController: new AbortController(), toolServer, allowedTools, persistSession: true })

  forbiddenPosture(options)
  assert.deepEqual(options.tools, [], "built-in Claude Code tools are removed")
  assert.equal(options.permissionMode, "dontAsk", "anything not allowlisted is denied, never prompted")
  assert.deepEqual(options.allowedTools, ["mcp__opencode__read", "mcp__opencode__shell", "mcp__opencode__edit"])
  assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["opencode"])
  assert.equal(options.strictMcpConfig, true, "user MCP configs are ignored")
  assert.deepEqual(options.settingSources, [], "user/project settings cannot add allow rules or hooks")
})

test("without OpenCode tools, Claude answers in text only: nothing runs outside OpenCode", () => {
  const options = agentOptions("/work", { model: "m", abortController: new AbortController(), allowedTools: ["Read"], persistSession: true })
  forbiddenPosture(options)
  assert.deepEqual(options.tools, [], "no built-in Claude Code tools, not even read-only ones")
  assert.deepEqual(options.allowedTools, [], "nothing is allowed without a bridged tool server")
  assert.equal(options.permissionMode, "dontAsk")
  assert.deepEqual(options.mcpServers, {})
  assert.equal(options.strictMcpConfig, true, "user MCP configs are ignored")
  assert.deepEqual(options.settingSources, [])
})

test("session fields map onto the public Agent SDK options", () => {
  const base = { model: "m", abortController: new AbortController(), allowedTools: [] }
  const fresh = agentOptions("/work", { ...base, sessionId: "11111111-1111-4111-8111-111111111111", persistSession: true, systemPrompt: "OpenCode rules" })
  assert.equal(fresh.sessionId, "11111111-1111-4111-8111-111111111111")
  assert.equal(fresh.resume, undefined)
  assert.equal(fresh.persistSession, true)
  assert.deepEqual(fresh.systemPrompt, { type: "custom", prompt: "OpenCode rules", snapshot: false })

  const resumed = agentOptions("/work", { ...base, resume: "sdk-1", sessionId: "ignored", persistSession: true })
  assert.equal(resumed.resume, "sdk-1")
  assert.equal(resumed.sessionId, undefined, "sessionId cannot be combined with resume")
  assert.equal(resumed.systemPrompt, undefined)

  const throwaway = agentOptions("/work", { ...base, persistSession: false })
  assert.equal(throwaway.persistSession, false)
  assert.equal(throwaway.sessionId, undefined)
})

test("a configured Claude Code executable is passed to the Agent SDK", () => {
  const base = { model: "m", abortController: new AbortController(), allowedTools: [], persistSession: false }
  assert.equal(agentOptions("/work", base, "/opt/claude/bin/claude").pathToClaudeCodeExecutable, "/opt/claude/bin/claude")
  assert.equal("pathToClaudeCodeExecutable" in agentOptions("/work", base), false)
})

test("summarized thinking is requested only when the bridge knows the model supports it", () => {
  const base = { model: "sonnet", abortController: new AbortController(), allowedTools: [], persistSession: false }
  assert.deepEqual(agentOptions("/work", { ...base, showThinking: true }).thinking, { type: "adaptive", display: "summarized" })
  assert.equal(agentOptions("/work", base).thinking, undefined, "otherwise the Agent SDK default is left alone")
})
