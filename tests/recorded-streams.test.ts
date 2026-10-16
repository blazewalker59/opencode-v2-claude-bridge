import assert from "node:assert/strict"
import test from "node:test"
import { type BridgeServerOptions, startBridgeServer } from "../src/bridge-server.js"
import type { ChatCompletionChunk, ChatMessage } from "../src/openai.js"
import { scriptedRun } from "./helpers/fake-agent.js"
import {
  assistantToolCalls,
  post,
  READ_TOOL,
  type SseResult,
  TEST_TOKEN,
  textOf,
  timelineOf,
  toolCallsOf,
  toolMessage,
  usageOf,
} from "./helpers/http.js"
import { apiMessages, expectedUsage, loadStream, replay, textOfEvents, thinkingOfEvents } from "./helpers/recorded.js"

const ASK: ChatMessage = { role: "user", content: "Recorded scenario." }

const withRecording = async (name: string, body: (port: number) => Promise<void>, options: Partial<BridgeServerOptions> = {}) => {
  const bridge = await startBridgeServer({ token: TEST_TOKEN, cwd: process.cwd(), run: scriptedRun(replay(loadStream(name))), ...options })
  try {
    await body(bridge.port)
  } finally {
    await bridge.close()
  }
}

const reasoningOf = (result: SseResult) =>
  result.events
    .map((event) => (event as ChatCompletionChunk).choices?.[0]?.delta.reasoning_content ?? "")
    .join("")

test("recorded text reply: text, usage and finish arrive as Claude Code sent them", async () => {
  const [message] = apiMessages(loadStream("text"))
  await withRecording("text", async (port) => {
    const result = await post(port, { model: "haiku", stream: true, messages: [ASK] })
    assert.equal(textOf(result), textOfEvents(message!))
    assert.ok(textOf(result).length > 0)
    assert.deepEqual(usageOf(result), expectedUsage(message!))
    assert.equal(timelineOf(result).at(-1), "finish:stop")
    assert.equal(result.done, true)
  })
})

test("recorded tool round trip: the read call reaches OpenCode, and its result continues the same turn", async () => {
  const [first, second] = apiMessages(loadStream("tool"))
  await withRecording("tool", async (port) => {
    const call = await post(port, { model: "haiku", stream: true, messages: [ASK], tools: [READ_TOOL] })
    assert.deepEqual(
      toolCallsOf(call).map((tool) => ({ name: tool.function.name, arguments: JSON.parse(tool.function.arguments) })),
      [{ name: "read", arguments: { filePath: "notes.txt" } }],
    )
    assert.equal(timelineOf(call).at(-1), "finish:tool_calls")
    assert.deepEqual(usageOf(call), expectedUsage(first!))

    const id = toolCallsOf(call)[0]!.id
    const reply = await post(port, {
      model: "haiku",
      stream: true,
      tools: [READ_TOOL],
      messages: [ASK, assistantToolCalls(call), toolMessage(id, "Recorded fixture file: the answer is 42.")],
    })
    assert.equal(textOf(reply), textOfEvents(second!))
    assert.match(textOf(reply), /42/)
    assert.deepEqual(usageOf(reply), expectedUsage(second!))
    assert.equal(timelineOf(reply).at(-1), "finish:stop")
  })
})

test("recorded summarized thinking streams as reasoning before the answer", async () => {
  const [message] = apiMessages(loadStream("thinking"))
  const thinking = thinkingOfEvents(message!)
  assert.ok(thinking.length > 0, "the recording contains summarized thinking")
  await withRecording(
    "thinking",
    async (port) => {
      const result = await post(port, { model: "sonnet", stream: true, messages: [ASK] })
      assert.equal(reasoningOf(result), thinking)
      assert.equal(textOf(result), textOfEvents(message!))
      assert.match(textOf(result), /24/)
      assert.deepEqual(usageOf(result), expectedUsage(message!))
    },
    { summarizedThinking: () => true },
  )
})
