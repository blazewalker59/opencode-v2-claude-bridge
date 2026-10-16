import { randomUUID } from "node:crypto"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { AgentRun, AgentRunInput } from "../../src/bridge-server.js"

/**
 * Offline stand-in for the Agent SDK: scripts emit the same Anthropic stream
 * events the SDK forwards with `includePartialMessages`, and call bridged
 * tools through a real MCP client connected to the bridge's in-process server,
 * as the Claude Code subprocess would.
 */
export type ScriptContext = { prompt: string; client: Client | undefined; input: AgentRunInput }
export type Script = (context: ScriptContext) => AsyncGenerator<SDKMessage>

export const scriptedRun =
  (script: Script, runs: AgentRunInput[] = []): AgentRun =>
  async function* (input) {
    runs.push(input)
    const first = await input.prompt[Symbol.asyncIterator]().next()
    const prompt = first.done ? "" : String(first.value.message.content)
    let client: Client | undefined
    if (input.toolServer) {
      client = new Client({ name: "fake-claude-code", version: "0.0.0" })
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
      await Promise.all([input.toolServer.instance.connect(serverSide), client.connect(clientSide)])
    }
    try {
      yield* script({ prompt, client, input })
    } finally {
      await client?.close()
    }
  }

const streamEvent = (event: unknown) =>
  ({ type: "stream_event", event, parent_tool_use_id: null, uuid: randomUUID(), session_id: "fake" }) as unknown as SDKMessage

/** A message_start frame; pass usage to report token counts as the API does. */
export const messageStart = (usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }) =>
  streamEvent({ type: "message_start", message: usage ? { usage } : {} })
/** A message_delta frame with the message's cumulative output count. */
export const messageDelta = (outputTokens: number) => streamEvent({ type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: outputTokens } })
export const messageStop = () => streamEvent({ type: "message_stop" })

export const textBlock = (index: number, text: string) => [
  streamEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
  streamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
  streamEvent({ type: "content_block_stop", index }),
]

/** A tool_use block whose JSON input arrives split across several deltas. */
export const toolUseBlock = (index: number, id: string, name: string, input: unknown) => {
  const json = typeof input === "string" ? input : JSON.stringify(input)
  const middle = Math.floor(json.length / 2)
  return [
    streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }),
    streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, middle) } }),
    streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(middle) } }),
    streamEvent({ type: "content_block_stop", index }),
  ]
}

/** A rate_limit_event, as Claude Code reports a usage window's state. */
export const rateLimitEvent = (info: Record<string, unknown>) =>
  ({ type: "rate_limit_event", rate_limit_info: info, uuid: randomUUID(), session_id: "fake" }) as unknown as SDKMessage

export const success = () => ({ type: "result", subtype: "success", is_error: false, result: "done" }) as unknown as SDKMessage

export const failure = (errors: string[]) =>
  ({ type: "result", subtype: "error_during_execution", is_error: true, errors }) as unknown as SDKMessage

/**
 * What the SDK emits when the API rejects a request: a synthetic assistant
 * message carrying the error category, then a "success" result with is_error
 * set and the API's message as the result.
 */
export function* apiError(message: string, category: string, status: number | null): Generator<SDKMessage> {
  yield {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: message }] },
    parent_tool_use_id: null,
    error: category,
  } as unknown as SDKMessage
  yield { type: "result", subtype: "success", is_error: true, result: message, api_error_status: status } as unknown as SDKMessage
}

/** Text of an MCP tool result, as Claude would read it. */
export const resultText = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content ?? []).map((part) => part.text ?? "").join("")

export const isErrorResult = (result: unknown) => (result as { isError?: boolean }).isError === true

export const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })

export type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}
