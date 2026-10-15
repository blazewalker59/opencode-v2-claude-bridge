import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { MAX_LOGGED_ITEMS, MAX_LOGGED_STRING, openDebugLog } from "../src/debug-log.js"

test("no path, no log", () => {
  assert.equal(openDebugLog(undefined), undefined)
})

test("the log is JSON lines that only the user can read", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocb-log-"))
  try {
    const path = join(dir, "bridge.log")
    openDebugLog(path)!("turn.start", { model: "sonnet" })
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.deepEqual(lines.map((line) => line.event), ["log.open", "turn.start"])
    assert.equal(lines[1]!.model, "sonnet")
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a path that cannot be written stops the plugin from loading, naming the path", () => {
  assert.throws(() => openDebugLog("/nonexistent-dir/bridge.log"), /Cannot write the debug log at \/nonexistent-dir\/bridge\.log/)
})

test("a write that fails later switches the log off instead of throwing into a request", () => {
  let writes = 0
  const log = openDebugLog("/log", () => {
    writes++
    if (writes > 1) throw new Error("ENOSPC: no space left on device")
  })!
  assert.doesNotThrow(() => log("request", {}))
  assert.doesNotThrow(() => log("request", {}))
  assert.equal(writes, 2, "no further writes after the first failure")
})

test("an existing log readable by others is tightened to the user only", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ocb-log-"))
  try {
    const path = join(dir, "bridge.log")
    writeFileSync(path, "", { mode: 0o644 })
    chmodSync(path, 0o644)
    openDebugLog(path)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a symbolic link at the log path is refused, not followed", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ocb-log-"))
  try {
    const target = join(dir, "elsewhere.log")
    writeFileSync(target, "")
    const path = join(dir, "bridge.log")
    symlinkSync(target, path)
    assert.throws(() => openDebugLog(path), /Cannot write the debug log/)
    assert.equal(readFileSync(target, "utf8"), "", "nothing written through the link")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("long strings, such as error text Claude Code reports, are cut short", () => {
  const lines: string[] = []
  const log = openDebugLog("/log", (_path, line) => void lines.push(line))!
  log("request.error", { message: "x".repeat(MAX_LOGGED_STRING + 100), status: 500 })
  const entry = JSON.parse(lines[1]!) as { message: string; status: number }
  assert.equal(entry.message.length, MAX_LOGGED_STRING + 1)
  assert.ok(entry.message.endsWith("…"))
  assert.equal(entry.status, 500)
})

test("the mode is restored on every write, not only when the log is opened", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ocb-log-"))
  try {
    const path = join(dir, "bridge.log")
    const log = openDebugLog(path)!
    chmodSync(path, 0o644)
    log("request", {})
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("only a regular file with one link is used: not a FIFO, a device, or a hard link", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ocb-log-"))
  try {
    const fifo = join(dir, "fifo.log")
    execFileSync("mkfifo", [fifo])
    // Refused without blocking: with no reader the non-blocking open fails at once (ENXIO).
    assert.throws(() => openDebugLog(fifo), /Cannot write the debug log/)
    assert.throws(() => openDebugLog("/dev/null"), /not a regular file/)
    const target = join(dir, "notes.txt")
    writeFileSync(target, "mine")
    const linked = join(dir, "bridge.log")
    linkSync(target, linked)
    assert.throws(() => openDebugLog(linked), /more than one hard link/)
    assert.equal(readFileSync(target, "utf8"), "mine")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("long arrays are capped, with the rest counted", () => {
  const lines: string[] = []
  const log = openDebugLog("/log", (_path, line) => void lines.push(line))!
  log("request", { roles: Array.from({ length: MAX_LOGGED_ITEMS + 10 }, () => "user") })
  const entry = JSON.parse(lines[1]!) as { roles: string[] }
  assert.equal(entry.roles.length, MAX_LOGGED_ITEMS + 1)
  assert.equal(entry.roles.at(-1), "…(+10)")
})
