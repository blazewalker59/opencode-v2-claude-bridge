import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk"

/**
 * How the bridge reports a failed turn to OpenCode: an HTTP-style status and
 * an Anthropic-style error type in the stream's error chunk.
 *
 * OpenCode decides whether to retry from these. It never retries quota (402),
 * authentication (401/403) or other 4xx errors; it retries rate limits (429)
 * and server errors (5xx) with backoff. An error chunk without a numeric code
 * is an "unknown provider" error, which OpenCode retries up to 11 times.
 * Claude Code has already retried transient API errors itself by the time the
 * bridge sees them.
 */
export type ErrorClass = { status: number; type: string }

/** What the Agent SDK said about a failure; any part may be missing. */
export type AgentFailure = {
  message: string
  /** The `error` field of the synthetic assistant message the SDK emits for an API error. */
  category?: SDKAssistantMessageError
  /** `api_error_status` on the result message. */
  status?: number | null
}

const QUOTA = { status: 402, type: "billing_error" }
const AUTH = { status: 401, type: "authentication_error" }
const FORBIDDEN = { status: 403, type: "permission_error" }
const RATE_LIMIT = { status: 429, type: "rate_limit_error" }
const OVERLOADED = { status: 529, type: "overloaded_error" }
const SERVER = { status: 500, type: "api_error" }
const INVALID = { status: 400, type: "invalid_request_error" }
const NOT_FOUND = { status: 404, type: "not_found_error" }
/** Failures inside the bridge or Claude Code with no API status: reported once, not retried. */
export const BRIDGE_ERROR: ErrorClass = { status: 400, type: "bridge_error" }

const BY_CATEGORY: Record<SDKAssistantMessageError, ErrorClass | undefined> = {
  billing_error: QUOTA,
  authentication_failed: AUTH,
  cloud_credential_error: AUTH,
  oauth_org_not_allowed: FORBIDDEN,
  account_on_hold: FORBIDDEN,
  verification_required: FORBIDDEN,
  rate_limit: RATE_LIMIT,
  overloaded: OVERLOADED,
  server_error: SERVER,
  invalid_request: INVALID,
  max_output_tokens: INVALID,
  model_not_found: NOT_FOUND,
  unknown: undefined,
}

const QUOTA_TEXT = /out of (extra )?usage|usage limit|credit balance|insufficient[-_\s]?quota|quota[-_\s]?exceeded|billing/i
const AUTH_TEXT = /not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth token/i
const OVERLOADED_TEXT = /overloaded/i

const byStatus = (status: number): ErrorClass => {
  if (status === 402) return QUOTA
  if (status === 401) return AUTH
  if (status === 403) return FORBIDDEN
  if (status === 404) return NOT_FOUND
  if (status === 429) return RATE_LIMIT
  if (status === 529) return OVERLOADED
  if (status >= 500) return { status, type: "api_error" }
  if (status === 400) return INVALID
  // Other 4xx statuses keep their number, so OpenCode shows what the API said.
  return { status, type: status === 408 ? "timeout_error" : status === 413 ? "request_too_large" : "invalid_request_error" }
}

/**
 * Classify a failed turn. The SDK's category decides, then the API status.
 * The message wording only refines an answer that is missing or generic: the
 * API reports some quota exhaustion as a 400 (invalid request) or a 429 (rate
 * limit), and retrying either cannot help. A clear category or status (a
 * server error, say) is never overridden by a word in its message.
 */
export const classifyAgentError = (failure: AgentFailure): ErrorClass => {
  const reported =
    (failure.category ? BY_CATEGORY[failure.category] : undefined) ??
    (typeof failure.status === "number" ? byStatus(failure.status) : undefined)
  if (reported && reported !== INVALID && reported !== RATE_LIMIT) return reported
  if (QUOTA_TEXT.test(failure.message)) return QUOTA
  if (reported) return reported
  if (AUTH_TEXT.test(failure.message)) return AUTH
  if (OVERLOADED_TEXT.test(failure.message)) return OVERLOADED
  return BRIDGE_ERROR
}

/**
 * True when the account cannot make requests right now, so trying another
 * run plan (a transcript replay after a failed resume) would fail the same way.
 */
export const isAccountError = (error: ErrorClass): boolean => [401, 402, 403, 429, 529].includes(error.status)
