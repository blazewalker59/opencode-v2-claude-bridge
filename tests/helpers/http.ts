import { TOKEN_HEADER } from "../../src/bridge-server.js"
import type { ChatCompletionChunk, ChatMessage } from "../../src/openai.js"

/** Passed to every test bridge as its token, so requests can authenticate. */
export const TEST_TOKEN = "test-token"
export const AUTH = { [TOKEN_HEADER]: TEST_TOKEN }

export type SseResult = {
  status: number
  /** Parsed `data:` payloads, excluding the `[DONE]` sentinel. */
  events: unknown[]
  done: boolean
  json?: { error?: { message?: string } }
}

export const post = async (port: number, body: unknown, headers: Record<string, string> = {}): Promise<SseResult> => {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH, ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return { status: response.status, events: [], done: false, json: JSON.parse(text) }
  }
  const payloads = text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice("data: ".length))
  return {
    status: response.status,
    events: payloads.filter((payload) => payload !== "[DONE]").map((payload) => JSON.parse(payload) as unknown),
    done: payloads.at(-1) === "[DONE]",
  }
}

const chunks = (result: SseResult) =>
  result.events.filter((event): event is ChatCompletionChunk => (event as ChatCompletionChunk).object === "chat.completion.chunk")

export const textOf = (result: SseResult) => chunks(result).map((chunk) => chunk.choices[0]?.delta.content ?? "").join("")

export const toolCallsOf = (result: SseResult) =>
  chunks(result).flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? [])

/** The `usage` OpenCode reads from a response: the last one any chunk carried. */
export const usageOf = (result: SseResult) => chunks(result).flatMap((chunk) => (chunk.usage ? [chunk.usage] : [])).at(-1)

export const finishReasonsOf = (result: SseResult) =>
  chunks(result)
    .map((chunk) => chunk.choices[0]?.finish_reason)
    .filter((reason) => reason !== null && reason !== undefined)

/** Ordered sequence of "text:<t>", "tool:<name>", "finish:<reason>" for ordering assertions. */
export const timelineOf = (result: SseResult) =>
  chunks(result).flatMap((chunk) => {
    const choice = chunk.choices[0]
    if (!choice) return []
    const steps: string[] = []
    if (choice.delta.content) steps.push(`text:${choice.delta.content}`)
    for (const call of choice.delta.tool_calls ?? []) steps.push(`tool:${call.function.name}`)
    if (choice.finish_reason) steps.push(`finish:${choice.finish_reason}`)
    return steps
  })

export const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
  },
}

export const GREP_TOOL = {
  type: "function",
  function: {
    name: "grep",
    description: "Search files",
    parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
}

/** The assistant message OpenCode records for the tool calls the bridge streamed. */
export const assistantToolCalls = (result: SseResult): ChatMessage => ({
  role: "assistant",
  content: textOf(result),
  tool_calls: toolCallsOf(result).map((call) => ({ id: call.id, type: "function", function: call.function })),
})

export const toolMessage = (id: string, content: ChatMessage["content"]): ChatMessage => ({
  role: "tool",
  tool_call_id: id,
  content,
})
