import assert from "node:assert/strict"
import test from "node:test"
import { classifyAgentError, isAccountError } from "../src/errors.js"

// Seen live: an account with no extra usage left.
const OUT_OF_USAGE = "API Error: 400 You're out of extra usage. Ask your workspace admin to add more so you can keep going."

test("exhausted usage is a quota error even when the API reports it as a 400", () => {
  assert.deepEqual(classifyAgentError({ message: OUT_OF_USAGE, status: 400 }), { status: 402, type: "billing_error" })
  assert.deepEqual(classifyAgentError({ message: OUT_OF_USAGE, category: "invalid_request" }), { status: 402, type: "billing_error" })
  assert.equal(classifyAgentError({ message: "Claude AI usage limit reached", status: 429 }).status, 402)
  assert.equal(classifyAgentError({ message: "Credit balance is too low" }).status, 402)
})

test("the SDK's error category decides when the message is not conclusive", () => {
  const cases = [
    ["billing_error", 402],
    ["authentication_failed", 401],
    ["oauth_org_not_allowed", 403],
    ["account_on_hold", 403],
    ["rate_limit", 429],
    ["overloaded", 529],
    ["server_error", 500],
    ["invalid_request", 400],
    ["model_not_found", 404],
  ] as const
  for (const [category, status] of cases) {
    assert.equal(classifyAgentError({ message: "API Error", category }).status, status, category)
  }
})

test("without a category, the API status decides", () => {
  assert.deepEqual(classifyAgentError({ message: "API Error", category: "unknown", status: 503 }), { status: 503, type: "api_error" })
  assert.equal(classifyAgentError({ message: "API Error", status: 429 }).type, "rate_limit_error")
  assert.deepEqual(classifyAgentError({ message: "API Error", status: 418 }), { status: 418, type: "invalid_request_error" })
})

test("login problems are authentication errors", () => {
  assert.deepEqual(classifyAgentError({ message: "Not logged in · Please run /login" }), { status: 401, type: "authentication_error" })
})

test("failures with no API status are reported once, not retried", () => {
  const error = classifyAgentError({ message: "Claude Agent SDK error (error_during_execution): No conversation found with session ID: x" })
  assert.deepEqual(error, { status: 400, type: "bridge_error" })
  assert.equal(isAccountError(error), false, "a failed resume may still fall back to a replay")
  assert.equal(classifyAgentError({ message: "overloaded" }).status, 529)
})

test("account errors are the ones a replay cannot fix", () => {
  for (const status of [401, 402, 403, 429, 529]) assert.equal(isAccountError({ status, type: "x" }), true, String(status))
  for (const status of [400, 404, 500]) assert.equal(isAccountError({ status, type: "x" }), false, String(status))
})

test("a clear category or status is never overridden by the wording of its message", () => {
  assert.deepEqual(classifyAgentError({ message: "Internal error while checking billing", category: "server_error" }), { status: 500, type: "api_error" })
  assert.equal(classifyAgentError({ message: "Upstream billing service unavailable", status: 503 }).status, 503)
  assert.equal(classifyAgentError({ message: "Overloaded; not logged in to the cache", category: "overloaded" }).status, 529)
  assert.equal(classifyAgentError({ message: "Rate limited", status: 429 }).status, 429, "a plain rate limit stays retryable")
})

test("other 4xx statuses keep their number", () => {
  assert.deepEqual(classifyAgentError({ message: "API Error", status: 413 }), { status: 413, type: "request_too_large" })
  assert.deepEqual(classifyAgentError({ message: "API Error", status: 408 }), { status: 408, type: "timeout_error" })
})

test("a failure after Claude Code reported a spent usage window is a quota error, never a retried rate limit", () => {
  const rejected = { status: "rejected", rateLimitType: "five_hour", resetsAt: 1792170000 } as const
  assert.equal(classifyAgentError({ message: "API Error: 429 rate limited", category: "rate_limit", rateLimit: rejected }).status, 402)
  assert.equal(classifyAgentError({ message: "Something unexpected", rateLimit: rejected }).status, 402)
  assert.equal(
    classifyAgentError({ message: "API Error: 500", category: "server_error", rateLimit: rejected }).status,
    500,
    "a clear server error is not overridden",
  )
  assert.equal(classifyAgentError({ message: "API Error: 429 rate limited", category: "rate_limit", rateLimit: { status: "allowed_warning" } }).status, 429)
})
