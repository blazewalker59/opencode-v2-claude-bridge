import assert from "node:assert/strict"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  BridgeRequestError,
  canonicalJson,
  convertTools,
  createToolServer,
  followUpNote,
  parseToolPolicy,
  PendingToolCalls,
  TOOL_USE_ID_META,
  toToolResult,
} from "../src/tool-bridge.js"
import { isErrorResult, resultText } from "./helpers/fake-agent.js"

const fn = (name: string, parameters?: unknown) => ({ type: "function", function: { name, description: `${name} tool`, parameters } })

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] })

test("the read-only policy bridges read tools and question, withholding the rest", () => {
  const { tools, withheld } = convertTools([fn("read"), fn("shell"), fn("edit"), fn("grep"), fn("question"), fn("execute")])
  assert.deepEqual(
    tools.map((tool) => [tool.openCodeName, tool.qualifiedName, tool.readOnly]),
    [
      ["read", "mcp__opencode__read", true],
      ["grep", "mcp__opencode__grep", true],
      ["question", "mcp__opencode__question", false],
    ],
  )
  assert.deepEqual(withheld, ["shell", "edit", "execute"])
})

test("the opencode policy bridges every tool, marking only read tools read-only", () => {
  const { tools, withheld } = convertTools([fn("read"), fn("shell"), fn("edit")], "opencode")
  assert.deepEqual(
    tools.map((tool) => [tool.openCodeName, tool.readOnly]),
    [
      ["read", true],
      ["shell", false],
      ["edit", false],
    ],
  )
  assert.deepEqual(withheld, [])
})

test("parseToolPolicy defaults to read-only and rejects anything unrecognized", () => {
  assert.equal(parseToolPolicy(undefined), "read-only")
  assert.equal(parseToolPolicy("opencode"), "opencode")
  for (const value of ["all", "OPENCODE", true, null, { policy: "opencode" }]) {
    assert.throws(() => parseToolPolicy(value), /Invalid toolPolicy/)
  }
})

test("convertTools rejects malformed definitions with actionable errors", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{}, /must be an array/],
    [[{ type: "custom", function: { name: "read" } }], /tools\[0\] must be/],
    [[fn("")], /name must be a non-empty string/],
    [[fn("read"), fn("read")], /defined more than once/],
    [[fn("read", "not-a-schema")], /parameters must be a JSON Schema object/],
    [[fn("read", { type: "string" })], /parameters.type must be "object"/],
    [[{ type: "function", function: { name: "read", description: 7 } }], /description must be a string/],
  ]
  for (const [input, message] of cases) {
    assert.throws(
      () => convertTools(input),
      (error: unknown) => error instanceof BridgeRequestError && error.status === 400 && message.test(error.message),
    )
  }
})

test("convertTools normalizes names that the Claude API would reject", () => {
  const long = `read${"x".repeat(80)}`
  const { tools } = convertTools([fn("read.file"), fn("read_file"), fn(long)], "opencode")
  for (const tool of tools) assert.match(tool.qualifiedName, /^[a-zA-Z0-9_-]{1,64}$/)
  assert.equal(new Set(tools.map((tool) => tool.mcpName)).size, 3)
  assert.equal(tools[1]?.mcpName, "read_file")
})

test("MCP tools/list returns OpenCode's JSON Schema without loss", async () => {
  const schema = {
    type: "object",
    $schema: "http://json-schema.org/draft-07/schema#",
    properties: {
      filePath: { type: "string", description: "Absolute path" },
      offset: { type: "integer", minimum: 0, default: 0 },
      mode: { enum: ["text", "binary"] },
      range: {
        anyOf: [{ type: "null" }, { $ref: "#/$defs/range" }],
      },
    },
    required: ["filePath"],
    additionalProperties: false,
    $defs: { range: { type: "object", properties: { start: { type: "integer" } }, additionalProperties: false } },
  }
  const { tools } = convertTools([fn("read", schema), fn("glob")])
  const client = new Client({ name: "test", version: "0" })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([createToolServer(tools, new PendingToolCalls()).instance.connect(serverSide), client.connect(clientSide)])
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools[0]?.inputSchema, schema)
    assert.equal(listed.tools[0]?.name, "read")
    assert.equal(listed.tools[0]?.annotations?.readOnlyHint, true)
    assert.deepEqual(listed.tools[1]?.inputSchema, { type: "object" }, "missing parameters become an empty object schema")
    schema.properties.filePath.description = "mutated after conversion"
    assert.equal(((await client.listTools()).tools[0]?.inputSchema.properties as any).filePath.description, "Absolute path")
  } finally {
    await client.close()
  }
})

test("canonicalJson ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }))
})

test("PendingToolCalls resolves a handler that waits for its result", async () => {
  const pending = new PendingToolCalls()
  pending.register("toolu_1", "read", { filePath: "a.ts" })
  const claimed = pending.claim("read", { filePath: "a.ts" })
  assert.equal(pending.deliver("toolu_1", ok("contents")), true)
  assert.equal(resultText(await claimed), "contents")
  assert.equal(pending.size, 0)
})

test("PendingToolCalls buffers a result delivered before the handler registers", async () => {
  const pending = new PendingToolCalls()
  pending.register("toolu_1", "read", { filePath: "a.ts" })
  assert.equal(pending.deliver("toolu_1", ok("early")), true)
  assert.equal(resultText(await pending.claim("read", { filePath: "a.ts" })), "early")
  assert.equal(pending.size, 0)
})

test("PendingToolCalls pairs handlers by arguments, not arrival order", async () => {
  const pending = new PendingToolCalls()
  pending.register("toolu_a", "read", { filePath: "a.ts" })
  pending.register("toolu_b", "read", { filePath: "b.ts" })
  const b = pending.claim("read", { filePath: "b.ts" })
  const a = pending.claim("read", { filePath: "a.ts" })
  pending.deliver("toolu_a", ok("A"))
  pending.deliver("toolu_b", ok("B"))
  assert.deepEqual([resultText(await a), resultText(await b)], ["A", "B"])
})

test("PendingToolCalls rejects duplicate and unknown deliveries", async () => {
  const pending = new PendingToolCalls()
  pending.register("toolu_1", "read", {})
  assert.equal(pending.deliver("toolu_1", ok("first")), true)
  assert.equal(pending.deliver("toolu_1", ok("second")), false)
  assert.equal(pending.deliver("toolu_missing", ok("x")), false)
  assert.equal(resultText(await pending.claim("read", {})), "first")
})

test("PendingToolCalls refuses a handler whose tool_use never arrives", async () => {
  const pending = new PendingToolCalls(20)
  const result = await pending.claim("read", { filePath: "a.ts" })
  assert.equal(isErrorResult(result), true)
  assert.match(resultText(result), /no pending "read" call/)
})

test("PendingToolCalls pairs a handler that arrives before its tool_use is registered", async () => {
  const pending = new PendingToolCalls()
  const early = pending.claim("read", { filePath: "a.ts" })
  pending.register("toolu_1", "read", { filePath: "a.ts" })
  assert.equal(pending.deliver("toolu_1", ok("contents")), true)
  assert.equal(resultText(await early), "contents")
  assert.equal(pending.size, 0)
})

test("PendingToolCalls.close refuses handlers still waiting for their tool_use", async () => {
  const pending = new PendingToolCalls()
  const early = pending.claim("read", {})
  pending.close("turn ended")
  assert.equal(resultText(await early), "turn ended")
})

test("PendingToolCalls releases a handler whose MCP request is cancelled", async () => {
  const pending = new PendingToolCalls()
  pending.register("toolu_1", "read", {})
  const abort = new AbortController()
  const claimed = pending.claim("read", {}, abort.signal)
  abort.abort()
  const result = await claimed
  assert.equal(isErrorResult(result), true)
  assert.match(resultText(result), /cancelled/)
  assert.equal(pending.size, 0)
  assert.equal(pending.deliver("toolu_1", ok("late")), false)
})

test("PendingToolCalls.close settles every waiter and refuses later claims", async () => {
  const pending = new PendingToolCalls()
  pending.register("toolu_1", "read", { filePath: "a.ts" })
  pending.register("toolu_2", "grep", { pattern: "x" })
  const waiting = [pending.claim("read", { filePath: "a.ts" }), pending.claim("grep", { pattern: "x" })]
  pending.close("session interrupted")
  for (const result of await Promise.all(waiting)) {
    assert.equal(isErrorResult(result), true)
    assert.equal(resultText(result), "session interrupted")
  }
  assert.equal(pending.size, 0)
  assert.equal(resultText(await pending.claim("read", {})), "session interrupted")
})

test("toToolResult converts OpenCode tool messages and rejects malformed content", () => {
  assert.deepEqual(toToolResult({ role: "tool", content: "out" }, 0), ok("out"))
  assert.deepEqual(toToolResult({ role: "tool", content: null }, 0), ok("(no output)"))
  assert.deepEqual(toToolResult({ role: "tool", content: [{ type: "text", text: "a" }, { text: "b" }] }, 0), {
    content: [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ],
  })
  assert.match(resultText(toToolResult({ role: "tool", content: [{ type: "image_url" }] }, 0)), /unsupported attachment omitted: image without a data or http\(s\) URL/)
  assert.throws(() => toToolResult({ role: "tool", content: 42 as never }, 3), /messages\[3\]\.content must be a string/)
  assert.throws(() => toToolResult({ role: "tool", content: [{ type: "text", text: 1 as never }] }, 2), /content\[0\]\.text must be a string/)
  assert.throws(() => toToolResult({ role: "tool", content: ["raw" as never] }, 1), /content\[0\] must be an object/)
})

test("followUpNote labels each added message and skips empty ones", () => {
  assert.equal(followUpNote([]), undefined)
  assert.equal(followUpNote([{ role: "user", content: "" }]), undefined)
  assert.deepEqual(
    followUpNote([
      { role: "user", content: "notice" },
      { role: "system", content: [{ type: "text", text: "rule" }] },
    ]),
    [
      { type: "text", text: "OpenCode added the following to the conversation after these tool results:" },
      { type: "text", text: '<opencode-message role="user">\nnotice\n</opencode-message>' },
      { type: "text", text: '<opencode-message role="system">\nrule\n</opencode-message>' },
    ],
  )
})

// Captured verbatim from OpenCode 2.0.21 with the fake agent (no Claude requests).
const OPENCODE_DENIED = '{"error":{"type":"permission.rejected","message":"Permission denied: shell"},"content":[]}'
const OPENCODE_QUESTION_CANCELLED =
  '{"error":{"type":"tool.execution","message":"This non-interactive run cannot ask the user questions, so the question was cancelled. Continue without an answer; make reasonable assumptions and state them."},"content":[]}'

test("toToolResult turns OpenCode's error envelope into an MCP error result", () => {
  const denied = toToolResult({ role: "tool", content: OPENCODE_DENIED }, 0)
  assert.equal(isErrorResult(denied), true)
  assert.equal(resultText(denied), "Permission denied: shell (OpenCode permission.rejected)")

  const cancelled = toToolResult({ role: "tool", content: OPENCODE_QUESTION_CANCELLED }, 0)
  assert.equal(isErrorResult(cancelled), true)
  assert.match(resultText(cancelled), /question was cancelled.*\(OpenCode tool\.execution\)$/)
})

test("toToolResult leaves JSON-looking tool output that is not the exact envelope alone", () => {
  for (const text of [
    '{"error":{"type":"x","message":"y"},"content":[{"type":"text","text":"partial"}]}',
    '{"error":{"type":"x","message":"y"},"content":[],"extra":1}',
    '{"error":"plain string","content":[]}',
    '{"error":{"type":"x","message":"y"},"content":[]',
    ' {"error":{"type":"x","message":"y"},"content":[]}',
  ]) {
    const result = toToolResult({ role: "tool", content: text }, 0)
    assert.equal(isErrorResult(result), false, text)
    assert.equal(resultText(result), text)
  }
})

// A valid 1x1 PNG, as OpenCode sends it (data URL in an image_url part).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

test("an image OpenCode adds after a read result reaches Claude as an image", () => {
  // Captured shape: OpenCode's read tool answers "Image read successfully" and
  // sends the image itself in the next user message.
  const note = followUpNote([
    { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }, { type: "text", text: "<system-update>" }] },
  ])
  assert.deepEqual(note?.slice(1), [
    { type: "text", text: '<opencode-message role="user">\n<system-update>\n</opencode-message>' },
    { type: "image", data: PNG, mimeType: "image/png" },
  ])
})

test("tool results keep images and note what they cannot carry", () => {
  const result = toToolResult(
    {
      role: "tool",
      content: [
        { type: "text", text: "screenshot:" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
        { type: "file", file: { filename: "spec.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } },
        { type: "input_audio" },
      ],
    },
    0,
  )
  assert.deepEqual(result.content, [
    { type: "text", text: "screenshot:" },
    { type: "image", data: PNG, mimeType: "image/png" },
    { type: "text", text: "[attachment not passed through a tool result: application/pdf spec.pdf]" },
    { type: "text", text: "[unsupported attachment omitted: content part input_audio]" },
  ])
})

test("PendingToolCalls pairs identical parallel calls by Claude Code's tool_use ID, whatever order they arrive in", async () => {
  const pending = new PendingToolCalls()
  pending.register("toolu_1", "read", { filePath: "same.ts" })
  pending.register("toolu_2", "read", { filePath: "same.ts" })
  const second = pending.claim("read", { filePath: "same.ts" }, undefined, "toolu_2")
  const first = pending.claim("read", { filePath: "same.ts" }, undefined, "toolu_1")
  pending.deliver("toolu_1", ok("one"))
  pending.deliver("toolu_2", ok("two"))
  assert.deepEqual([resultText(await first), resultText(await second)], ["one", "two"])
})

test("PendingToolCalls parks a named handler until its own tool_use registers, not a look-alike", async () => {
  const pending = new PendingToolCalls()
  const named = pending.claim("read", { filePath: "a.ts" }, undefined, "toolu_2")
  const unnamed = pending.claim("read", { filePath: "a.ts" })
  pending.register("toolu_1", "read", { filePath: "a.ts" })
  pending.register("toolu_2", "read", { filePath: "a.ts" })
  pending.deliver("toolu_1", ok("for the unnamed handler"))
  pending.deliver("toolu_2", ok("for toolu_2"))
  assert.equal(resultText(await named), "for toolu_2")
  assert.equal(resultText(await unnamed), "for the unnamed handler")
})

test("a handler naming a tool_use that never arrives falls back to tool name and arguments when the wait ends", async () => {
  const pending = new PendingToolCalls(20)
  pending.register("toolu_streamed", "read", { filePath: "a.ts" })
  const named = pending.claim("read", { filePath: "a.ts" }, undefined, "toolu_other_format")
  pending.deliver("toolu_streamed", ok("paired by arguments"))
  assert.equal(resultText(await named), "paired by arguments")
  assert.equal(pending.size, 0)

  const unmatched = await pending.claim("glob", {}, undefined, "toolu_missing")
  assert.match(resultText(unmatched), /no pending "glob" call/, "with nothing to pair, it is still refused")
})

test("the MCP server reads the tool_use ID Claude Code stamps on tools/call", async () => {
  const pending = new PendingToolCalls()
  const { tools } = convertTools([{ type: "function", function: { name: "read", parameters: { type: "object" } } }], "read-only")
  const server = createToolServer(tools, pending)
  const client = new Client({ name: "claude-code", version: "0" })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)])
  try {
    pending.register("toolu_1", "read", {})
    pending.register("toolu_2", "read", {})
    const call = client.callTool({ name: "read", arguments: {}, _meta: { [TOOL_USE_ID_META]: "toolu_2" } })
    await new Promise((resolve) => setImmediate(resolve))
    pending.deliver("toolu_2", ok("second"))
    assert.equal(resultText(await call), "second")
    assert.equal(pending.size, 1, "toolu_1 is still waiting for its own handler")
  } finally {
    await client.close()
  }
})
