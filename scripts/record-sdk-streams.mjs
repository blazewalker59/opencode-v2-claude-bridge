#!/usr/bin/env node
// Records real Agent SDK message streams as test fixtures (tests/fixtures/sdk-streams/*.jsonl).
//
// This makes live Claude requests and uses plan quota: run it only deliberately,
// after `npm run build`, when an SDK upgrade or a new scenario needs fresh fixtures.
//
//   node scripts/record-sdk-streams.mjs [--rescrub] [scenario ...]
//
// Each query runs with the bridge's own child setup (dist/claude-code.js) and
// a stand-in for the bridged OpenCode `read` tool. Only the message types the
// bridge reads are kept, and identifiers are replaced, so fixtures carry no
// session IDs, paths, or account details. Review a fixture before committing it.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { CHILD_SETTINGS, childEnv, SETTING_SOURCES } from "../dist/claude-code.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const out = join(root, "tests", "fixtures", "sdk-streams")

/** The bridged read tool's stand-in returns this for any path. */
export const READ_RESULT = "Recorded fixture file: the answer is 42."

const SCENARIOS = {
  text: { model: "haiku", prompt: "Reply with exactly: Hello from the fixture.", tools: false, thinking: false },
  tool: {
    model: "haiku",
    prompt: "Use the read tool on notes.txt, then reply with one short sentence that quotes the number it contains.",
    tools: true,
    thinking: false,
  },
  thinking: {
    model: "sonnet",
    prompt:
      "Think carefully before answering: in how many distinct ways can 37 cents be made from pennies, nickels, dimes and quarters? Reply with just the number.",
    tools: false,
    thinking: true,
  },
}

const KEPT = new Set(["stream_event", "assistant", "user", "result", "rate_limit_event"])

/** A neutral usage-window state: the real one describes the recording account's plan and usage. */
const RATE_LIMIT_INFO = { status: "allowed", rateLimitType: "five_hour", resetsAt: 1800000000, utilization: 0.1 }

/** Replace identifiers and drop fields that describe the recording machine or account. */
const scrub = (message, index, ids) => {
  // Stable stand-ins, so one message's id matches everywhere it appears.
  const stable = (id) => (typeof id === "string" ? (ids.get(id) ?? ids.set(id, `${id.split("_")[0]}_recorded${ids.size}`).get(id)) : id)
  // API message and request IDs appear under several keys (id, request_id, api_message_id), so replace them by shape.
  const replaceIds = (value) =>
    typeof value === "string" && /^(msg|req)_[A-Za-z0-9]+$/.test(value)
      ? stable(value)
      : Array.isArray(value)
        ? value.map(replaceIds)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, replaceIds(inner)]))
          : value
  const copy = { ...replaceIds(message), session_id: "recorded-session", uuid: `recorded-${index}` }
  if ("timestamp" in copy) copy.timestamp = "2026-01-01T00:00:00.000Z"
  if (copy.type === "rate_limit_event") copy.rate_limit_info = RATE_LIMIT_INFO
  if (copy.type === "result") {
    for (const key of ["modelUsage", "permission_denials", "total_cost_usd", "duration_ms", "duration_api_ms", "fast_mode_state"]) delete copy[key]
  }
  return copy
}

const write = (name, messages) => {
  const ids = new Map()
  const file = join(out, `${name}.jsonl`)
  writeFileSync(file, messages.map((message, index) => JSON.stringify(scrub(message, index, ids))).join("\n") + "\n")
  return file
}

const record = async (name, scenario) => {
  const cwd = mkdtempSync(join(tmpdir(), "bridge-record-"))
  const server = createSdkMcpServer({
    name: "opencode",
    version: "1.0.0",
    tools: [tool("read", "Read a file from the project.", { filePath: z.string() }, async () => ({ content: [{ type: "text", text: READ_RESULT }] }))],
  })
  const messages = []
  for await (const message of query({
    prompt: scenario.prompt,
    options: {
      model: scenario.model,
      cwd,
      settingSources: SETTING_SOURCES,
      settings: CHILD_SETTINGS,
      env: childEnv(),
      tools: [],
      strictMcpConfig: true,
      permissionMode: "dontAsk",
      persistSession: false,
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", snapshot: false },
      mcpServers: scenario.tools ? { opencode: server } : {},
      allowedTools: scenario.tools ? ["mcp__opencode__read"] : [],
      ...(scenario.thinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
    },
  })) {
    if (KEPT.has(message.type)) messages.push(message)
  }
  const file = write(name, messages)
  const result = messages.at(-1)
  console.log(`${name}: ${messages.length} messages, ${result?.subtype ?? "no result"} -> ${file}`)
}

mkdirSync(out, { recursive: true })
const args = process.argv.slice(2)
// --rescrub applies the current scrubbing to existing fixtures, with no live requests.
const rescrub = args.includes("--rescrub")
const names = args.filter((arg) => arg !== "--rescrub")
for (const name of names.length > 0 ? names : Object.keys(SCENARIOS)) {
  if (rescrub) {
    const messages = readFileSync(join(out, `${name}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    console.log(`${name}: rescrubbed -> ${write(name, messages)}`)
    continue
  }
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`Unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(", ")}`)
  await record(name, scenario)
}
