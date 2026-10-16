import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { MCP_TOOL_PREFIX, TOOL_USE_ID_META } from "../../src/tool-bridge.js"
import type { Script } from "./fake-agent.js"

/**
 * Real Agent SDK streams recorded by `scripts/record-sdk-streams.mjs`. They
 * carry the frames hand-written scripts leave out (message_delta usage,
 * signature deltas, rate_limit_event, the full assistant message arriving
 * before the last content_block_stop), so the bridge is tested against what
 * Claude Code actually sends.
 */
export const loadStream = (name: string): SDKMessage[] =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", "sdk-streams", `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SDKMessage)

type Block = { type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; text?: string }
const blocks = (message: SDKMessage): Block[] => {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as Block[]) : []
}

/**
 * Replay a recorded stream. Where Claude Code called a bridged tool (a recorded
 * tool_result), the replay calls it through the bridge's MCP server first and
 * waits for OpenCode's answer, as Claude Code would.
 */
export const replay =
  (messages: SDKMessage[]): Script =>
  async function* ({ client }) {
    const calls = new Map<string, { name: string; arguments: Record<string, unknown> }>()
    for (const message of messages) {
      if (message.type === "assistant") {
        for (const block of blocks(message)) {
          if (block.type === "tool_use" && block.id && block.name?.startsWith(MCP_TOOL_PREFIX)) {
            calls.set(block.id, { name: block.name.slice(MCP_TOOL_PREFIX.length), arguments: block.input as Record<string, unknown> })
          }
        }
      } else if (message.type === "user") {
        for (const block of blocks(message)) {
          const call = block.type === "tool_result" && block.tool_use_id ? calls.get(block.tool_use_id) : undefined
          // As Claude Code does, the request names the tool_use it answers.
          if (call) await client!.callTool({ ...call, _meta: { [TOOL_USE_ID_META]: block.tool_use_id } })
        }
      }
      yield message
    }
  }

type StreamEvent = { type: string; delta?: { type: string; text?: string; thinking?: string }; message?: { usage?: Record<string, number> }; usage?: { output_tokens?: number } }
const events = (messages: SDKMessage[]) =>
  messages.flatMap((message) => (message.type === "stream_event" && message.parent_tool_use_id === null ? [message.event as unknown as StreamEvent] : []))

/** The recorded stream split into one list of events per Claude API message. */
export const apiMessages = (messages: SDKMessage[]): StreamEvent[][] => {
  const result: StreamEvent[][] = []
  for (const event of events(messages)) {
    if (event.type === "message_start") result.push([])
    result.at(-1)?.push(event)
  }
  return result
}

export const textOfEvents = (list: StreamEvent[]) =>
  list.map((event) => (event.type === "content_block_delta" && event.delta?.type === "text_delta" ? (event.delta.text ?? "") : "")).join("")

export const thinkingOfEvents = (list: StreamEvent[]) =>
  list.map((event) => (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" ? (event.delta.thinking ?? "") : "")).join("")

/** The OpenAI usage the bridge should report for one recorded API message. */
export const expectedUsage = (list: StreamEvent[]) => {
  const start = list.find((event) => event.type === "message_start")?.message?.usage ?? {}
  const output = list.filter((event) => event.type === "message_delta").at(-1)?.usage?.output_tokens ?? start.output_tokens ?? 0
  const cached = start.cache_read_input_tokens ?? 0
  const written = start.cache_creation_input_tokens ?? 0
  const prompt = (start.input_tokens ?? 0) + cached + written
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output, prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: written } }
}
