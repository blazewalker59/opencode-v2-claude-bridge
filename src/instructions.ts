import { readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

/** Largest part of one instruction file passed to Claude, in characters. */
export const MAX_FILE_CHARS = 64_000
/** Largest total of all instruction files passed to Claude, in characters. */
export const MAX_TOTAL_CHARS = 128_000

export type Instructions = {
  /** Text appended to Claude Code's system prompt; undefined when no file was found. */
  text: string | undefined
  /** Files included, from the most general to the most specific. */
  files: string[]
  /** Files cut short or left out because of the size limits. */
  truncated: string[]
  /** Files that exist but could not be read, with the reason. */
  unreadable: Array<{ path: string; message: string }>
}

type Candidate = string[]

const exists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/**
 * The instruction files OpenCode would load, from the most general to the most
 * specific: one global file, then one file per directory from the project root
 * down to `cwd`. Each candidate lists names in order of preference; the first
 * that exists is used, as OpenCode prefers AGENTS.md over CLAUDE.md.
 */
const candidates = async (cwd: string, home: string, configHome: string): Promise<Candidate[]> => {
  const project: Candidate[] = []
  // Walk up to the repository root, never into the home directory, whose files the global entry covers.
  for (let dir = cwd; dir !== home; dir = dirname(dir)) {
    project.unshift([join(dir, "AGENTS.md"), join(dir, "CLAUDE.md")])
    if ((await exists(join(dir, ".git"))) || dirname(dir) === dir) break
  }
  return [[join(configHome, "opencode", "AGENTS.md"), join(home, ".claude", "CLAUDE.md")], ...project]
}

/**
 * Read the user's instruction files for Claude Code's system prompt. These are
 * the user's own files, read the way OpenCode finds them; OpenCode's agent
 * prompt is never forwarded. Missing files are skipped; a file that cannot be
 * read is reported rather than failing the turn.
 */
export const readInstructions = async (
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Instructions> => {
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config")
  const result: Instructions = { text: undefined, files: [], truncated: [], unreadable: [] }
  const sections: string[] = []
  let total = 0
  for (const names of await candidates(cwd, home, configHome)) {
    for (const path of names) {
      let content: string
      try {
        content = await readFile(path, "utf8")
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") continue
        result.unreadable.push({ path, message: error instanceof Error ? error.message : String(error) })
        break
      }
      if (content.trim().length === 0) break
      const room = Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - total)
      if (room <= 0) {
        result.truncated.push(path)
        break
      }
      const cut = content.length > room
      const body = cut ? `${content.slice(0, room)}\n\n[Truncated: the rest of this file was left out.]` : content
      if (cut) result.truncated.push(path)
      total += Math.min(content.length, room)
      sections.push(`Instructions from ${path}:\n\n${body.trimEnd()}`)
      result.files.push(path)
      break
    }
  }
  if (sections.length > 0) {
    result.text = [
      "# User instructions",
      "The user's instruction files follow, from the most general to the most specific. Follow them; where they conflict, the more specific file wins.",
      ...sections,
    ].join("\n\n")
  }
  return result
}
