import { isAbsolute, resolve } from "node:path"
import { parseToolPolicy, type ToolPolicy } from "./tool-bridge.js"

export type BridgePluginOptions = {
  toolPolicy: ToolPolicy
  /** Restrict the model picker to these model IDs. */
  models?: string[]
  /** Model for session titles. Defaults to `haiku` so titles do not cost a large-model query. */
  titleModel: string
  /** Path to the Claude Code executable, for unusual installations. */
  claudeExecutable?: string
  /** JSON-lines debug log (metadata and error messages, never message content). The OPENCODE_CLAUDE_BRIDGE_DEBUG_LOG variable also works. */
  debugLog?: string
  /** Directory Claude Code runs in, absolute or relative to the OpenCode project. Defaults to the project. */
  workingDirectory?: string
  /** Directory for Claude Code's own debug log, one file per query. Off by default: these logs can contain message content. */
  claudeDebugDir?: string
}

const KEYS = ["toolPolicy", "models", "titleModel", "claudeExecutable", "debugLog", "workingDirectory", "claudeDebugDir"] as const

const nonEmptyString = (key: string, value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Plugin option ${key} must be a non-empty string`)
  return value
}

/** A model ID, without surrounding whitespace (`" sonnet"` would reach the Agent SDK as written). */
const modelId = (key: string, value: unknown): string => nonEmptyString(key, value).trim()

const absolutePath = (key: string, value: unknown): string => {
  const path = nonEmptyString(key, value)
  if (!isAbsolute(path)) throw new Error(`Plugin option ${key} must be an absolute path`)
  return path
}

/**
 * Validate the plugin's options. Anything unrecognized or malformed stops the
 * plugin from loading with a message naming the option; nothing is silently
 * ignored or widened.
 */
export const parsePluginOptions = (raw: Readonly<Record<string, unknown>> | undefined): BridgePluginOptions => {
  const options = raw ?? {}
  const unknown = Object.keys(options).filter((key) => !(KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) throw new Error(`Unknown plugin option ${unknown.join(", ")}; expected: ${KEYS.join(", ")}`)

  let models: string[] | undefined
  if (options.models !== undefined) {
    if (!Array.isArray(options.models) || options.models.length === 0) {
      throw new Error("Plugin option models must be a non-empty array of model IDs")
    }
    // A repeated ID would register the same model twice.
    models = [...new Set(options.models.map((model, index) => modelId(`models[${index}]`, model)))]
  }

  return {
    toolPolicy: parseToolPolicy(options.toolPolicy),
    models,
    titleModel: options.titleModel === undefined ? "haiku" : modelId("titleModel", options.titleModel),
    claudeExecutable:
      options.claudeExecutable === undefined ? undefined : absolutePath("claudeExecutable", options.claudeExecutable),
    debugLog: options.debugLog === undefined ? undefined : absolutePath("debugLog", options.debugLog),
    workingDirectory:
      options.workingDirectory === undefined ? undefined : nonEmptyString("workingDirectory", options.workingDirectory),
    claudeDebugDir: options.claudeDebugDir === undefined ? undefined : absolutePath("claudeDebugDir", options.claudeDebugDir),
  }
}

/**
 * The directory Claude Code runs in for one OpenCode project. A relative
 * `workingDirectory` resolves against each project, so one global setting
 * (for example `packages/api` or `..`) means the same thing everywhere. It
 * must already exist; a typo stops the plugin from loading instead of failing
 * mid-turn.
 */
export const resolveWorkingDirectory = (
  project: string,
  option: string | undefined,
  isDirectory: (path: string) => boolean,
): string => {
  if (option === undefined) return project
  const path = resolve(project, option)
  if (!isDirectory(path)) throw new Error(`Plugin option workingDirectory resolves to ${path}, which is not an existing directory`)
  return path
}
