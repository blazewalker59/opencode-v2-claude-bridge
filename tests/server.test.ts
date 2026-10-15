import assert from "node:assert/strict"
import { request as httpRequest } from "node:http"
import test from "node:test"
import { type AgentRunInput, startBridgeServer, TOKEN_HEADER } from "../src/bridge-server.js"
import { deferred, messageStart, messageStop, scriptedRun, success, textBlock, waitForAbort } from "./helpers/fake-agent.js"
import { AUTH, finishReasonsOf, post, TEST_TOKEN, textOf } from "./helpers/http.js"

test("bridge exposes OpenAI-compatible SSE without calling Claude", async () => {
  const prompts: string[] = []
  const runs: AgentRunInput[] = []
  const bridge = await startBridgeServer({ token: TEST_TOKEN,
    cwd: process.cwd(),
    run: scriptedRun(async function* ({ prompt }) {
      prompts.push(prompt)
      yield messageStart()
      yield* textBlock(0, "Hello")
      yield messageStop()
      yield success()
    }, runs),
  })

  try {
    const health = await fetch(`http://127.0.0.1:${bridge.port}/health`)
    assert.deepEqual(await health.json(), { status: "ok" })

    const response = await post(bridge.port, {
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [{ role: "user", content: "Say hello" }],
    })

    assert.equal(response.status, 200)
    assert.equal(textOf(response), "Hello")
    assert.equal(response.done, true)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0] ?? "", /Say hello/)
    assert.equal(runs[0]?.model, "claude-sonnet-4-6")
  } finally {
    await bridge.close()
  }
})


test("Claude's thinking streams as OpenAI-compatible reasoning_content", async () => {
  const bridge = await startBridgeServer({ token: TEST_TOKEN,
    cwd: process.cwd(),
    run: scriptedRun(async function* () {
      yield messageStart()
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Considering." } } } as never
      yield* textBlock(1, "Answer.")
      yield messageStop()
      yield success()
    }),
  })
  try {
    const response = await post(bridge.port, { model: "sonnet", stream: true, messages: [{ role: "user", content: "Think" }] })
    const deltas = response.events.map((event) => (event as { choices?: Array<{ delta: Record<string, unknown> }> }).choices?.[0]?.delta)
    assert.ok(deltas.some((delta) => delta?.reasoning_content === "Considering."))
    assert.equal(textOf(response), "Answer.")
  } finally {
    await bridge.close()
  }
})

const hello = scriptedRun(async function* () {
  yield messageStart()
  yield* textBlock(0, "Hello")
  yield messageStop()
  yield success()
})

const BODY = JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "Hi" }] })

/** A raw request, so tests can send the headers fetch will not let them set (Host). */
const raw = (port: number, headers: Record<string, string>, body = BODY) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions", headers }, (response) => {
      let text = ""
      response.on("data", (chunk) => (text += chunk))
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }))
    })
    request.on("error", reject)
    request.end(body)
  })

test("only a caller holding this launch's token can start a Claude turn", async () => {
  const runs: AgentRunInput[] = []
  const bridge = await startBridgeServer({ cwd: process.cwd(), run: scriptedRun(async function* () {}, runs) })
  try {
    assert.ok(bridge.token.length >= 32, "a fresh random token by default")
    const json = { "content-type": "application/json" }
    assert.equal((await raw(bridge.port, json)).status, 401, "no token")
    assert.equal((await raw(bridge.port, { ...json, [TOKEN_HEADER]: "guess" })).status, 401, "wrong token")
    assert.equal(runs.length, 0)
  } finally {
    await bridge.close()
  }
})

test("browsers and rebound hostnames are turned away, even with the token", async () => {
  const runs: AgentRunInput[] = []
  const bridge = await startBridgeServer({ token: TEST_TOKEN, cwd: process.cwd(), run: scriptedRun(async function* () {}, runs) })
  try {
    const headers = { "content-type": "application/json", ...AUTH }
    const rebound = await raw(bridge.port, { ...headers, host: `attacker.example:${bridge.port}` })
    assert.equal(rebound.status, 403)
    assert.match(rebound.body, /Unexpected Host header/)
    assert.equal((await raw(bridge.port, { ...headers, origin: "https://attacker.example" })).status, 403)
    // A form or text/plain POST needs no CORS preflight, so the content type must be JSON.
    assert.equal((await raw(bridge.port, { ...AUTH, "content-type": "text/plain" })).status, 415)
    assert.equal(runs.length, 0)
  } finally {
    await bridge.close()
  }
})

test("an oversized request body is refused with 413", async () => {
  const runs: AgentRunInput[] = []
  const bridge = await startBridgeServer({ token: TEST_TOKEN, cwd: process.cwd(), maxBodyBytes: 1_000, run: scriptedRun(async function* () {}, runs) })
  try {
    const big = JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "x".repeat(5_000) }] })
    const headers = { "content-type": "application/json", ...AUTH }
    assert.equal((await raw(bridge.port, headers, big)).status, 413, "declared length")
    assert.equal((await raw(bridge.port, { ...headers, "transfer-encoding": "chunked" }, big)).status, 413, "streamed without a length")
    assert.equal(runs.length, 0)
  } finally {
    await bridge.close()
  }
})

test("malformed requests are 400s naming the field, never a 500 or a Claude query", async () => {
  const runs: AgentRunInput[] = []
  const bridge = await startBridgeServer({ token: TEST_TOKEN, cwd: process.cwd(), run: scriptedRun(async function* () {}, runs) })
  try {
    const assistant = (tool_calls: unknown) => ({ role: "assistant", content: null, tool_calls })
    const cases: Array<[unknown, RegExp]> = [
      [[], /body must be a JSON object/],
      [{ model: "", messages: [{ role: "user", content: "x" }] }, /model must be a non-empty string/],
      [{ model: "sonnet", messages: [] }, /messages must be a non-empty array/],
      [{ model: "sonnet", messages: [null] }, /messages\[0\] must be an object/],
      [{ model: "sonnet", messages: [{ role: "user", content: 42 }] }, /messages\[0\]\.content must be a string or an array/],
      [{ model: "sonnet", messages: [{ role: "user", content: [null] }] }, /messages\[0\]\.content must be a string or an array/],
      [{ model: "sonnet", messages: [assistant("x")] }, /messages\[0\]\.tool_calls must be an array/],
      [{ model: "sonnet", messages: [assistant([null])] }, /tool_calls\[0\]\.id must be a non-empty string/],
      [{ model: "sonnet", messages: [assistant([{ id: "t1" }])] }, /tool_calls\[0\]\.function must have a string name/],
      [{ model: "sonnet", messages: [{ role: "tool", tool_call_id: 7, content: "x" }] }, /tool_call_id must be a string/],
    ]
    for (const [body, message] of cases) {
      const result = await post(bridge.port, body)
      assert.equal(result.status, 400, JSON.stringify(body))
      assert.match(result.json?.error?.message ?? "", message)
    }
    assert.equal(runs.length, 0)
  } finally {
    await bridge.close()
  }
})

test("shutting down mid-answer ends the stream with an error, not a normal finish", async () => {
  const streaming = deferred<void>()
  const bridge = await startBridgeServer({
    token: TEST_TOKEN,
    cwd: process.cwd(),
    run: scriptedRun(async function* ({ input }) {
      yield messageStart()
      yield* textBlock(0, "Partial")
      streaming.resolve()
      await waitForAbort(input.abortController.signal)
    }),
  })
  const response = post(bridge.port, { model: "sonnet", stream: true, messages: [{ role: "user", content: "Hi" }] })
  await streaming.promise
  await bridge.close()
  const result = await response
  assert.equal(textOf(result), "Partial")
  assert.deepEqual(finishReasonsOf(result), [], "never reported as finished")
  assert.match((result.events.at(-1) as { error?: { message?: string } }).error?.message ?? "", /shutting down/)
  assert.equal(result.done, true)
})

test("a request OpenCode abandons before the turn starts never starts a Claude query", async () => {
  const runs: AgentRunInput[] = []
  const thinkingAsked = deferred<void>()
  const answerThinking = deferred<boolean>()
  const closed = deferred<void>()
  const bridge = await startBridgeServer({
    token: TEST_TOKEN,
    cwd: process.cwd(),
    run: (input) => {
      runs.push(input)
      return hello(input)
    },
    // Holds the turn before it starts, as waiting for model discovery can.
    summarizedThinking: () => {
      thinkingAsked.resolve()
      return answerThinking.promise
    },
    log: (event) => {
      if (event === "request.closed") closed.resolve()
    },
  })
  try {
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: BODY,
      signal: controller.signal,
    }).catch(() => undefined)
    await thinkingAsked.promise
    controller.abort()
    await pending
    // Give the server a moment to see the connection close before the turn would start.
    await new Promise((resolve) => setTimeout(resolve, 50))
    answerThinking.resolve(false)
    await closed.promise
    assert.equal(runs.length, 0)
  } finally {
    await bridge.close()
  }
})

test("a request still preparing its turn when the bridge shuts down never starts one, and shutdown finishes", { timeout: 5_000 }, async () => {
  const runs: AgentRunInput[] = []
  const thinkingAsked = deferred<void>()
  const answerThinking = deferred<boolean>()
  const bridge = await startBridgeServer({
    token: TEST_TOKEN,
    cwd: process.cwd(),
    run: (input) => {
      runs.push(input)
      return hello(input)
    },
    summarizedThinking: () => {
      thinkingAsked.resolve()
      return answerThinking.promise
    },
  })
  const response = post(bridge.port, { model: "sonnet", stream: true, messages: [{ role: "user", content: "Hi" }] })
  await thinkingAsked.promise
  const closing = bridge.close()
  answerThinking.resolve(false)
  const result = await response
  await closing
  assert.equal(result.status, 503)
  assert.equal(runs.length, 0)
  assert.equal(await bridge.close(), undefined, "closing again is harmless")
})

test("a request that arrives while the bridge is shutting down is answered, not left hanging", { timeout: 5_000 }, async () => {
  const bridge = await startBridgeServer({ token: TEST_TOKEN, cwd: process.cwd(), run: hello })
  // Headers sent, body not yet: the connection is active, so shutdown cannot drop it as idle.
  const pending = new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: bridge.port,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { "content-type": "application/json", ...AUTH, "content-length": Buffer.byteLength(BODY) },
      },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      },
    )
    request.on("error", reject)
    request.flushHeaders()
    setTimeout(() => request.end(BODY), 50)
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const closing = bridge.close()
  assert.equal(await pending, 503)
  await closing
})

test("only the exact Host OpenCode uses is accepted", async () => {
  const runs: AgentRunInput[] = []
  const bridge = await startBridgeServer({ token: TEST_TOKEN, cwd: process.cwd(), run: scriptedRun(async function* () {}, runs) })
  try {
    const headers = { "content-type": "application/json", ...AUTH }
    for (const host of ["localhost:" + bridge.port, "127.0.0.1", `127.0.0.1:${bridge.port + 1}`, `[::1]:${bridge.port}`]) {
      assert.equal((await raw(bridge.port, { ...headers, host })).status, 403, host)
    }
    assert.equal((await raw(bridge.port, { ...headers, "content-type": "application/jsonx" })).status, 415)
    assert.equal(runs.length, 0)
  } finally {
    await bridge.close()
  }
})

test("a malformed tool message anywhere in the history is a 400, and live turns are untouched", async () => {
  const runs: AgentRunInput[] = []
  const bridge = await startBridgeServer({ token: TEST_TOKEN, cwd: process.cwd(), run: scriptedRun(async function* () {}, runs) })
  try {
    const history = (content: unknown) => ({
      model: "sonnet",
      messages: [
        { role: "user", content: "Read a" },
        { role: "tool", tool_call_id: "x", content },
        { role: "assistant", content: "done" },
        { role: "user", content: "next" },
      ],
    })
    for (const content of [42, [null]]) {
      const result = await post(bridge.port, history(content))
      assert.equal(result.status, 400)
      assert.match(result.json?.error?.message ?? "", /messages\[1\]\.content must be a string or an array of content parts/)
    }
    assert.equal(runs.length, 0)
  } finally {
    await bridge.close()
  }
})

test("shutdown drops a connection stuck in a request after a grace period", { timeout: 5_000 }, async () => {
  const thinkingAsked = deferred<void>()
  const bridge = await startBridgeServer({
    token: TEST_TOKEN,
    cwd: process.cwd(),
    run: hello,
    closeGraceMs: 50,
    // Never answers: a request held here would otherwise keep close() waiting for ever.
    summarizedThinking: () => {
      thinkingAsked.resolve()
      return new Promise<boolean>(() => {})
    },
  })
  const response = post(bridge.port, { model: "sonnet", stream: true, messages: [{ role: "user", content: "Hi" }] }).catch(() => "dropped")
  await thinkingAsked.promise
  await bridge.close()
  assert.equal(await response, "dropped")
})

test("a Claude Code stream that ends without a result is an error, not a finished answer", async () => {
  const bridge = await startBridgeServer({
    token: TEST_TOKEN,
    cwd: process.cwd(),
    run: scriptedRun(async function* () {
      yield messageStart()
      yield* textBlock(0, "Partial")
    }),
  })
  try {
    const result = await post(bridge.port, { model: "sonnet", stream: true, messages: [{ role: "user", content: "Hi" }] })
    assert.equal(textOf(result), "Partial")
    assert.deepEqual(finishReasonsOf(result), [])
    assert.match((result.events.at(-1) as { error?: { message?: string } }).error?.message ?? "", /without a result/)
  } finally {
    await bridge.close()
  }
})
