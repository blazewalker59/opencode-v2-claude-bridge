import { createHash } from "node:crypto"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { type McpBlock, toMcpBlocks } from "./content.js"
import type { ChatMessage } from "./openai.js"

/** MCP server key; Claude sees bridged tools as `mcp__opencode__<name>`. */
export const MCP_SERVER_NAME = "opencode"
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** OpenCode tools that only read the workspace. Claude may run these in parallel. */
export const READ_ONLY_OPENCODE_TOOLS: readonly string[] = ["read", "glob", "grep"]

/**
 * Which OpenCode tools Claude may call. OpenCode executes every bridged call
 * under its own permission rules.
 *
 * - `read-only` (default): the read-only tools plus `question`, which asks the
 *   user through OpenCode's own UI. Write, shell, network and code-execution
 *   tools are withheld from Claude.
 * - `opencode`: every tool OpenCode offers. OpenCode's base policy allows
 *   `edit` and `shell` without asking, so choose this only alongside OpenCode
 *   `permissions` rules that ask for (or deny) what should not run unattended.
 */
export type ToolPolicy = "read-only" | "opencode"

export const TOOL_POLICIES: readonly ToolPolicy[] = ["read-only", "opencode"]

const READ_ONLY_POLICY_TOOLS: readonly string[] = [...READ_ONLY_OPENCODE_TOOLS, "question"]

/** Validate a user-supplied policy; anything unrecognized is an error, never a silent upgrade. */
export const parseToolPolicy = (value: unknown): ToolPolicy => {
  if (value === undefined) return "read-only"
  if (TOOL_POLICIES.includes(value as ToolPolicy)) return value as ToolPolicy
  throw new Error(`Invalid toolPolicy ${JSON.stringify(value)}; expected one of: ${TOOL_POLICIES.join(", ")}`)
}

const isAllowed = (policy: ToolPolicy, name: string) => policy === "opencode" || READ_ONLY_POLICY_TOOLS.includes(name)

const MAX_API_TOOL_NAME = 64

export class BridgeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type BridgedTool = {
  /** Name OpenCode knows and executes. */
  readonly openCodeName: string
  /** Name registered on the MCP server. */
  readonly mcpName: string
  /** Name Claude calls (`mcp__opencode__<mcpName>`). */
  readonly qualifiedName: string
  readonly description: string
  /** OpenCode's JSON Schema, passed to MCP verbatim. */
  readonly inputSchema: Record<string, unknown>
  readonly readOnly: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Map an OpenCode tool name onto the API's `[a-zA-Z0-9_-]{1,64}` rule, uniquely. */
const toMcpName = (name: string, taken: Set<string>): string => {
  const budget = MAX_API_TOOL_NAME - MCP_TOOL_PREFIX.length
  let candidate = name.replace(/[^a-zA-Z0-9_-]/g, "_")
  if (candidate !== name || candidate.length > budget || taken.has(candidate)) {
    const suffix = `_${createHash("sha256").update(name).digest("hex").slice(0, 8)}`
    candidate = `${candidate.slice(0, budget - suffix.length)}${suffix}`
  }
  if (taken.has(candidate)) throw new BridgeRequestError(400, `Tool name "${name}" collides with another tool after normalization`)
  taken.add(candidate)
  return candidate
}

/**
 * Convert OpenAI-style function tools from an OpenCode request into bridged
 * MCP tools. Definitions are validated strictly; only tools the policy allows
 * are bridged. Schemas are deep-copied unchanged, adding `type: "object"` only
 * when the definition omits it (MCP requires it).
 */
export const convertTools = (
  tools: unknown,
  policy: ToolPolicy = "read-only",
): { tools: BridgedTool[]; withheld: string[] } => {
  if (tools === undefined || tools === null) return { tools: [], withheld: [] }
  if (!Array.isArray(tools)) throw new BridgeRequestError(400, "`tools` must be an array of function tool definitions")

  const taken = new Set<string>()
  const seen = new Set<string>()
  const bridged: BridgedTool[] = []
  const withheld: string[] = []

  tools.forEach((tool, position) => {
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) {
      throw new BridgeRequestError(400, `tools[${position}] must be {"type":"function","function":{...}}`)
    }
    const { name, description, parameters } = tool.function
    if (typeof name !== "string" || name.length === 0) {
      throw new BridgeRequestError(400, `tools[${position}].function.name must be a non-empty string`)
    }
    if (seen.has(name)) throw new BridgeRequestError(400, `Tool "${name}" is defined more than once`)
    seen.add(name)
    if (description !== undefined && typeof description !== "string") {
      throw new BridgeRequestError(400, `tools[${position}].function.description must be a string`)
    }
    if (parameters !== undefined && !isRecord(parameters)) {
      throw new BridgeRequestError(400, `tools[${position}].function.parameters must be a JSON Schema object`)
    }
    if (parameters?.type !== undefined && parameters.type !== "object") {
      throw new BridgeRequestError(400, `tools[${position}].function.parameters.type must be "object"`)
    }

    if (!isAllowed(policy, name)) {
      withheld.push(name)
      return
    }
    const mcpName = toMcpName(name, taken)
    bridged.push({
      openCodeName: name,
      mcpName,
      qualifiedName: `${MCP_TOOL_PREFIX}${mcpName}`,
      description: description ?? "",
      inputSchema: { type: "object", ...structuredClone(parameters ?? {}) },
      readOnly: READ_ONLY_OPENCODE_TOOLS.includes(name),
    })
  })

  return { tools: bridged, withheld }
}

/** Key-order-independent JSON, used to correlate MCP calls with streamed tool_use input. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true })

/**
 * OpenCode 2.x reports a failed tool call (including a permission denial or a
 * cancelled question) as this JSON text, e.g.
 * `{"error":{"type":"permission.rejected","message":"Permission denied: shell"},"content":[]}`.
 * The match is exact so a tool whose real output is JSON is not misread.
 */
const openCodeError = (text: string): { type: string; message: string } | undefined => {
  if (!text.startsWith('{"error"')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || Object.keys(parsed).sort().join() !== "content,error") return undefined
  const { error, content } = parsed
  if (!isRecord(error) || typeof error.type !== "string" || typeof error.message !== "string") return undefined
  if (!Array.isArray(content) || content.length > 0) return undefined
  return { type: error.type, message: error.message }
}

/**
 * Convert one OpenCode `role: "tool"` message into an MCP tool result.
 * OpenCode's error envelope becomes an `isError` result so Claude knows the
 * call failed (for example, OpenCode denied permission); other content is
 * passed through as text.
 */
export const toToolResult = (message: ChatMessage, position: number): CallToolResult => {
  const { content } = message
  if (content === undefined || content === null || content === "") {
    return { content: [{ type: "text", text: "(no output)" }] }
  }
  if (typeof content === "string") {
    const error = openCodeError(content)
    if (error) return errorResult(`${error.message} (OpenCode ${error.type})`)
    return { content: [{ type: "text", text: content }] }
  }
  if (!Array.isArray(content)) {
    throw new BridgeRequestError(400, `messages[${position}].content must be a string or an array of content parts`)
  }
  content.forEach((part, partIndex) => {
    if (!isRecord(part)) throw new BridgeRequestError(400, `messages[${position}].content[${partIndex}] must be an object`)
    if ((part.type === undefined || part.type === "text") && typeof part.text !== "string") {
      throw new BridgeRequestError(400, `messages[${position}].content[${partIndex}].text must be a string`)
    }
  })
  // Images stay images; anything a tool result cannot carry becomes an explicit note.
  const blocks = toMcpBlocks(content)
  return { content: blocks.length > 0 ? blocks : [{ type: "text", text: "(no output)" }] }
}

/**
 * Render messages OpenCode added after its tool results, so they reach Claude
 * inside the continuing turn. Images (OpenCode's `read` tool returns an image
 * this way) stay images. Returns undefined when there is nothing to add.
 */
export const followUpNote = (messages: ChatMessage[]): McpBlock[] | undefined => {
  const rendered = messages.flatMap((message): McpBlock[] => {
    const blocks = toMcpBlocks(message.content)
    const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    const images = blocks.filter((block) => block.type === "image")
    if (text.length === 0 && images.length === 0) return []
    return [{ type: "text", text: `<opencode-message role="${message.role}">\n${text}\n</opencode-message>` }, ...images]
  })
  if (rendered.length === 0) return undefined
  return [{ type: "text", text: "OpenCode added the following to the conversation after these tool results:" }, ...rendered]
}

/** Append blocks to a tool result without mutating it. */
export const withNote = (result: CallToolResult, note: McpBlock[]): CallToolResult => ({
  ...result,
  content: [...result.content, ...note],
})

type PendingCall = {
  readonly id: string
  readonly mcpName: string
  readonly canonicalArgs: string
  claimed: boolean
  result?: CallToolResult
  waiter?: (result: CallToolResult) => void
}

type ParkedClaim = {
  readonly mcpName: string
  readonly canonicalArgs: string
  /** The tool_use ID Claude Code stamped on the MCP request, when it did. */
  readonly toolUseId?: string
  pair: (call: PendingCall) => void
  refuse: (result: CallToolResult) => void
}

/** Request metadata key in which Claude Code names the tool_use block an MCP call answers. */
export const TOOL_USE_ID_META = "claudecode/toolUseId"

/** How long an MCP handler waits for its streamed tool_use before it is refused. */
const DEFAULT_CLAIM_WAIT_MS = 5_000

/** The oldest entry with the same tool name and arguments, else the oldest with the same name; -1 if none. */
const bestMatch = (entries: ReadonlyArray<{ mcpName: string; canonicalArgs: string }>, mcpName: string, canonicalArgs: string) => {
  const exact = entries.findIndex((entry) => entry.mcpName === mcpName && entry.canonicalArgs === canonicalArgs)
  return exact >= 0 ? exact : entries.findIndex((entry) => entry.mcpName === mcpName)
}

/**
 * Tool calls Claude has made in one Agent SDK turn, keyed by the tool_use ID
 * that OpenCode echoes back as `tool_call_id`.
 *
 * Two independent events must meet: OpenCode delivering a result, and the
 * Agent SDK invoking the MCP handler. Either may happen first; whichever
 * comes second completes the call. Claude Code names the tool_use a request
 * answers in its `_meta` (`claudecode/toolUseId`), and the handler is paired
 * with exactly that call. That is a Claude Code extension, not part of MCP, so
 * a request without it is matched to the oldest unclaimed call with the same
 * tool name and arguments (falling back to the same tool name).
 *
 * The handler can also run before the bridge has seen the streamed tool_use
 * it answers: the Agent SDK handles MCP requests as they arrive but queues
 * stream events. An unmatched handler therefore waits briefly for that
 * tool_use instead of being refused while OpenCode still runs the tool.
 */
export class PendingToolCalls {
  private readonly calls = new Map<string, PendingCall>()
  /** Handlers waiting for their tool_use to be registered. */
  private readonly parked: ParkedClaim[] = []
  private closedReason: string | undefined

  constructor(private readonly claimWaitMs = DEFAULT_CLAIM_WAIT_MS) {}

  register(id: string, mcpName: string, args: unknown) {
    const call: PendingCall = { id, mcpName, canonicalArgs: canonicalJson(args), claimed: false }
    this.calls.set(id, call)
    // A handler that named this tool_use takes it; otherwise the best match among handlers that named none.
    const unnamed = this.parked.filter((parked) => !parked.toolUseId)
    const parked = this.parked.find((entry) => entry.toolUseId === id) ?? unnamed[bestMatch(unnamed, mcpName, call.canonicalArgs)]
    if (!parked) return
    this.parked.splice(this.parked.indexOf(parked), 1)
    call.claimed = true
    parked.pair(call)
  }

  /** Returns false when the ID is unknown or already has a result. */
  deliver(id: string, result: CallToolResult): boolean {
    const call = this.calls.get(id)
    if (!call || call.result) return false
    call.result = result
    if (call.waiter) {
      this.calls.delete(id)
      call.waiter(result)
    }
    return true
  }

  /** MCP handler entry point: resolves with OpenCode's result for the matching call. */
  claim(mcpName: string, args: unknown, signal?: AbortSignal, toolUseId?: string): Promise<CallToolResult> {
    if (this.closedReason) return Promise.resolve(errorResult(this.closedReason))
    const canonicalArgs = canonicalJson(args)
    const unclaimed = [...this.calls.values()].filter((call) => !call.claimed)
    // Claude Code names the tool_use a request answers; without that name, the best match by tool and arguments.
    const index = toolUseId ? unclaimed.findIndex((call) => call.id === toolUseId) : bestMatch(unclaimed, mcpName, canonicalArgs)
    if (index >= 0) {
      const call = unclaimed[index]!
      call.claimed = true
      return this.await(call, signal)
    }
    return new Promise((resolve) => {
      const parked: ParkedClaim = {
        mcpName,
        canonicalArgs,
        toolUseId,
        pair: (call) => {
          settle()
          resolve(this.await(call, signal))
        },
        refuse: (result) => {
          settle()
          resolve(result)
        },
      }
      const unpark = (result: CallToolResult) => {
        const at = this.parked.indexOf(parked)
        if (at >= 0) this.parked.splice(at, 1)
        parked.refuse(result)
      }
      const timer = setTimeout(() => {
        // A named tool_use that never arrived: should Claude Code's IDs ever stop matching the
        // streamed ones, pair by tool name and arguments, as for a request that names none.
        if (toolUseId) {
          const unclaimed = [...this.calls.values()].filter((call) => !call.claimed)
          const call = unclaimed[bestMatch(unclaimed, mcpName, canonicalArgs)]
          if (call) {
            this.parked.splice(this.parked.indexOf(parked), 1)
            call.claimed = true
            return parked.pair(call)
          }
        }
        unpark(errorResult(`The OpenCode bridge has no pending "${mcpName}" call to pair with this request; it was not executed.`))
      }, this.claimWaitMs)
      // Not unref'd: the wait is short and always belongs to a live turn, and a handler
      // that is still waiting must keep the process alive until it is paired or refused.
      const onAbort = () => unpark(errorResult("The tool call was cancelled before OpenCode returned a result."))
      const settle = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener("abort", onAbort, { once: true })
      this.parked.push(parked)
    })
  }

  private await(call: PendingCall, signal?: AbortSignal): Promise<CallToolResult> {
    if (call.result) {
      this.calls.delete(call.id)
      return Promise.resolve(call.result)
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        this.calls.delete(call.id)
        resolve(errorResult("The tool call was cancelled before OpenCode returned a result."))
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener("abort", onAbort, { once: true })
      call.waiter = (result) => {
        signal?.removeEventListener("abort", onAbort)
        resolve(result)
      }
    })
  }

  /** Number of calls still waiting for a handler or a result. */
  get size() {
    return this.calls.size
  }

  /** Settle every waiting handler with an error and refuse later claims. */
  close(reason: string) {
    this.closedReason ??= reason
    for (const call of this.calls.values()) call.waiter?.(errorResult(reason))
    this.calls.clear()
    for (const parked of this.parked.splice(0)) parked.refuse(errorResult(reason))
  }
}

/**
 * Build an in-process MCP server for the Agent SDK. Uses the MCP SDK's
 * low-level request handlers rather than `tool()`, because `tool()` requires
 * Zod shapes and converting OpenCode's JSON Schema to Zod would be lossy.
 */
export const createToolServer = (tools: BridgedTool[], pending: PendingToolCalls): McpSdkServerConfigWithInstance => {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } })
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.mcpName,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema) as { type: "object" },
      ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
      // Keep OpenCode's tools in the initial prompt instead of behind tool search.
      _meta: { "anthropic/alwaysLoad": true },
    })),
  }))
  server.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    // Claude Code stamps each tools/call with the tool_use it answers (a Claude Code extension, not MCP).
    const toolUseId = request.params._meta?.[TOOL_USE_ID_META]
    return pending.claim(request.params.name, request.params.arguments ?? {}, extra.signal, typeof toolUseId === "string" ? toolUseId : undefined)
  })
  return { type: "sdk", name: MCP_SERVER_NAME, instance: server }
}
