import { createHash, randomUUID } from "node:crypto"
import { contentKey, PromptAttachments, type PromptContent } from "./content.js"
import { type ChatMessage, textContent, toAgentPrompt, transcriptTags, wrapMessage } from "./openai.js"
import { canonicalJson } from "./tool-bridge.js"

/** Headers the plugin's `model.request` hook adds so the bridge knows which OpenCode session a request serves. */
export const SESSION_HEADER = "x-opencode-session-id"
export const KIND_HEADER = "x-opencode-request-kind"

/**
 * What the bridge remembers about an OpenCode session: the Agent SDK session
 * that holds its conversation, and a fingerprint of every non-system OpenCode
 * message that session already contains (up to, not including, Claude's
 * final reply of the last turn).
 */
export type SessionState = { sdkSessionId: string; history: string[] }

/** Where session state lives. The plugin backs this with OpenCode's plugin storage. */
export type SessionStore = {
  get: (openCodeSessionId: string) => Promise<SessionState | undefined>
  set: (openCodeSessionId: string, state: SessionState) => Promise<void>
  remove: (openCodeSessionId: string) => Promise<void>
}

export const memorySessionStore = (): SessionStore => {
  const states = new Map<string, SessionState>()
  return {
    get: async (id) => states.get(id),
    set: async (id, state) => void states.set(id, state),
    remove: async (id) => void states.delete(id),
  }
}

export const isSessionState = (value: unknown): value is SessionState => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<SessionState>
  return (
    typeof candidate.sdkSessionId === "string" &&
    Array.isArray(candidate.history) &&
    candidate.history.every((entry) => typeof entry === "string")
  )
}

/**
 * Fingerprint one message by meaning, not encoding: a string and a single
 * text part are the same, while attachments count as content.
 */
export const fingerprint = (message: ChatMessage): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        role: message.role,
        content: contentKey(message.content),
        tool_call_id: message.tool_call_id ?? null,
        tool_calls: (message.tool_calls ?? []).map((call) => [call.id, call.function.name, call.function.arguments]),
      }),
    )
    .digest("hex")
    .slice(0, 32)

/** OpenCode's leading system messages, which become the Agent SDK system prompt. */
export const splitSystem = (messages: ChatMessage[]): { system: string | undefined; conversation: ChatMessage[] } => {
  let start = 0
  while (start < messages.length && messages[start]!.role === "system") start++
  const system = messages
    .slice(0, start)
    .map((message) => textContent(message.content))
    .filter((text) => text.length > 0)
    .join("\n\n")
  return { system: system.length > 0 ? system : undefined, conversation: messages.slice(start) }
}

export type RunPlan = {
  prompt: PromptContent
  /** Resume this Agent SDK session, sending only `prompt` (the new messages). */
  resume?: string
  /** Start a new Agent SDK session with this ID. */
  sessionId?: string
  /** False for title/compaction requests and requests with no OpenCode session. */
  persist: boolean
  /** Why this plan was chosen, for the debug log. */
  reason: string
}

/** Render only the messages OpenCode added since Claude's last reply, attachments included. */
const deltaPrompt = (delta: ChatMessage[]): PromptContent => {
  const attachments = new PromptAttachments()
  if (delta.length === 1 && delta[0]!.role === "user") return attachments.prompt(attachments.render(delta[0]!.content))
  const tags = transcriptTags()
  const text = [tags.legend, ...delta.map((message) => wrapMessage(tags, message.role, attachments.render(message.content)))].join("\n\n")
  return attachments.prompt(text)
}

/**
 * Decide how to start a new Claude turn. Resume only when OpenCode's history
 * is exactly what the Agent SDK session already holds plus Claude's final
 * reply, followed by new user messages. Anything else (revert, compaction,
 * edited or forked history) replays the transcript into a fresh session,
 * which is always correct, just more expensive. Switching models still
 * resumes: the Agent SDK continues a session on whichever model the turn
 * asks for, as Claude Code's own model switch does.
 *
 * Returns the plans in order: a resume plan is followed by the replay plan,
 * used if the resume fails before Claude produces any output.
 */
export const planTurn = (
  conversation: ChatMessage[],
  state: SessionState | undefined,
  persist: boolean,
): RunPlan[] => {
  const replay: RunPlan = {
    prompt: toAgentPrompt(conversation),
    sessionId: persist ? randomUUID() : undefined,
    persist,
    reason: !persist ? "ephemeral" : state ? "history diverged" : "new session",
  }
  if (!persist || !state) return [replay]

  const { history } = state
  const prints = conversation.map(fingerprint)
  const finalReply = conversation[history.length]
  const delta = conversation.slice(history.length + 1)
  const matches =
    prints.length > history.length + 1 &&
    history.every((print, index) => prints[index] === print) &&
    finalReply?.role === "assistant" &&
    (finalReply.tool_calls ?? []).length === 0 &&
    delta.every((message) => message.role === "user" || message.role === "system")
  if (!matches) return [replay]

  return [
    { prompt: deltaPrompt(delta), resume: state.sdkSessionId, persist: true, reason: "resume" },
    { ...replay, reason: "resume failed" },
  ]
}

/**
 * Drop the mapping for every OpenCode session that is deleted, until the
 * event stream ends or is aborted. Agent SDK transcripts are left to Claude
 * Code's own retention (`cleanupPeriodDays`).
 */
export const forgetDeletedSessions = async (
  events: AsyncIterable<{ readonly type: string; readonly data?: unknown }>,
  store: SessionStore,
  onForget: (openCodeSessionId: string) => void = () => {},
  onError: SessionError = () => {},
): Promise<void> => {
  for await (const event of events) {
    if (event.type !== "session.deleted") continue
    const sessionID = (event.data as { sessionID?: unknown } | undefined)?.sessionID
    if (typeof sessionID !== "string") continue
    await forget(sessionID, store, onForget, onError)
  }
}

/** Called when one mapping cannot be removed; the rest are still processed. */
export type SessionError = (openCodeSessionId: string, error: unknown) => void

const forget = async (id: string, store: SessionStore, onForget: (id: string) => void, onError: SessionError) => {
  try {
    await store.remove(id)
  } catch (error) {
    onError(id, error)
    return
  }
  onForget(id)
}

/**
 * Remove mappings for OpenCode sessions deleted while the bridge was not
 * listening (for example, by a one-shot `opencode session delete`).
 * `exists` answers false only when OpenCode definitely has no such session;
 * undefined (unknown, e.g. a transport error) keeps the mapping.
 */
export const sweepDeletedSessions = async (
  openCodeSessionIds: AsyncIterable<string> | Iterable<string>,
  exists: (openCodeSessionId: string) => Promise<boolean | undefined>,
  store: SessionStore,
  onForget: (openCodeSessionId: string) => void = () => {},
  onError: SessionError = () => {},
): Promise<void> => {
  for await (const id of openCodeSessionIds) {
    if ((await exists(id)) !== false) continue
    await forget(id, store, onForget, onError)
  }
}
