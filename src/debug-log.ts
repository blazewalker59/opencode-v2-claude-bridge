import { closeSync, constants, fchmodSync, fstatSync, openSync, writeSync } from "node:fs"
import type { BridgeLog } from "./bridge-server.js"

type Append = (path: string, line: string) => void

/** Not available on Windows, where the open simply follows links as usual. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
/** A FIFO with no reader would otherwise block the open, and with it OpenCode's event loop. */
const NON_BLOCKING = constants.O_NONBLOCK ?? 0

/**
 * Why the opened path is not a log this user can safely own, or undefined.
 * Only a regular file qualifies (not a FIFO or a device such as /dev/null,
 * whose mode the chmod would change for everyone), with a single link (a hard
 * link planted in a shared directory could otherwise point at another of the
 * user's files), owned by this user (POSIX).
 */
const unsafeTarget = (fd: number): string | undefined => {
  const stat = fstatSync(fd)
  if (!stat.isFile()) return "it is not a regular file"
  if (stat.nlink > 1) return "it has more than one hard link"
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) return "it belongs to another user"
  return undefined
}

/**
 * Append one line, readable only by the user: the log holds session IDs, tool
 * names and error messages. The mode is set on every write, not only on
 * creation, so a log left by an older version or created by hand is
 * tightened too. A symbolic link at the path is refused rather than followed,
 * so a link planted in a shared directory cannot redirect the log.
 */
const appendPrivate: Append = (path, line) => {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW | NON_BLOCKING, 0o600)
  try {
    const unsafe = unsafeTarget(fd)
    if (unsafe) throw new Error(`refusing to write to it: ${unsafe}`)
    fchmodSync(fd, 0o600)
    writeSync(fd, line)
  } finally {
    closeSync(fd)
  }
}

/** Longest string kept in a log line; error text from Claude Code is cut to this. */
export const MAX_LOGGED_STRING = 500
/** Most array entries kept (a long session's roles, say); the rest are counted. */
export const MAX_LOGGED_ITEMS = 50

const shortenString = (value: string) => (value.length > MAX_LOGGED_STRING ? `${value.slice(0, MAX_LOGGED_STRING)}…` : value)

const shortenValue = (value: unknown): unknown => {
  if (typeof value === "string") return shortenString(value)
  if (!Array.isArray(value)) return value
  const kept = value.slice(0, MAX_LOGGED_ITEMS).map((item) => (typeof item === "string" ? shortenString(item) : item))
  return value.length > MAX_LOGGED_ITEMS ? [...kept, `…(+${value.length - MAX_LOGGED_ITEMS})`] : kept
}

const shorten = (detail: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, shortenValue(value)]))

/**
 * Opt-in JSON-lines diagnostics for troubleshooting a live OpenCode session:
 * metadata (roles, tool names, IDs, statuses) and error messages as Claude
 * Code reports them, cut to a few hundred characters. The bridge never logs
 * message content itself, but an error message from Claude Code or the API
 * could quote part of a request.
 *
 * The first line is written immediately, so a path that cannot be written
 * throws here, naming it. After that, a failed write (a full disk, say)
 * switches the log off instead of failing the request that was being logged.
 */
export const openDebugLog = (path: string | undefined, append: Append = appendPrivate): BridgeLog | undefined => {
  if (!path) return undefined
  const line = (event: string, detail: Record<string, unknown>) =>
    `${JSON.stringify({ time: new Date().toISOString(), event, ...shorten(detail) })}\n`
  try {
    append(path, line("log.open", { pid: process.pid }))
  } catch (error) {
    throw new Error(`Cannot write the debug log at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let enabled = true
  return (event, detail) => {
    if (!enabled) return
    try {
      append(path, line(event, detail))
    } catch {
      enabled = false
    }
  }
}
