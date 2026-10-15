import type { ErrorClass } from "./errors.js"

/** Environment variables that send the Agent SDK somewhere other than the locally signed-in account. */
export const GATEWAY_VARIABLES = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const

/** Names (never values) of gateway variables that are set. */
export const gatewayVariablesSet = (env: NodeJS.ProcessEnv): string[] =>
  GATEWAY_VARIABLES.filter((name) => (env[name] ?? "").length > 0)

const AUTH_ERROR = /not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth token/i
const MISSING_EXECUTABLE = /ENOENT|(executable|binary) not found|spawn .*claude|cannot find (the )?claude/i
const UNKNOWN_MODEL = /model.*(not found|not available|invalid|unsupported)|(unknown|invalid) model|not_found_error.*model/i

/**
 * Append repair hints to an Agent SDK error. The original text always comes
 * first and is never rewritten; hints only say what to check. Nothing here
 * claims anything about plans, quotas, or eligibility; the SDK's own text
 * covers those.
 *
 * When the error has been classified, the classification decides which hint
 * fits (a server error that mentions "authentication" is not a login
 * problem); the wording is only used for errors with no API status.
 */
export const explainAgentError = (message: string, error?: ErrorClass, env: NodeJS.ProcessEnv = process.env): string => {
  const hints: string[] = []
  const gateway = gatewayVariablesSet(env)
  // Failures inside the bridge or Claude Code carry no API status; only their wording says what went wrong.
  const unclassified = !error || error.type === "bridge_error"
  const isAuth = error && !unclassified ? error.status === 401 || error.status === 403 : AUTH_ERROR.test(message)
  const isUnknownModel = error && !unclassified ? error.status === 404 || UNKNOWN_MODEL.test(message) : UNKNOWN_MODEL.test(message)
  if (isAuth) {
    hints.push(
      gateway.length > 0
        ? `${gateway.join(", ")} ${gateway.length === 1 ? "is" : "are"} set for OpenCode, so the Agent SDK uses that configuration instead of your Claude login. Unset ${gateway.length === 1 ? "it" : "them"} to use \`claude login\`.`
        : "Run `claude login` in a terminal, then retry. The bridge never handles credentials itself.",
    )
  } else if (gateway.length > 0) {
    hints.push(`Note: ${gateway.join(", ")} ${gateway.length === 1 ? "is" : "are"} set for OpenCode and also affect${gateway.length === 1 ? "s" : ""} the Agent SDK.`)
  }
  if (unclassified && MISSING_EXECUTABLE.test(message)) {
    // Node reports a missing working directory the same way as a missing executable.
    hints.push(
      "Check that Claude Code is installed (`claude --version`), or set the plugin's `claudeExecutable` option. If you set `workingDirectory`, check that it still exists.",
    )
  }
  if (isUnknownModel) {
    hints.push("Pick a model listed under claude-agent-sdk in OpenCode's model picker; the list comes from your Claude Code installation.")
  }
  return hints.length > 0 ? `${message}\n\n${hints.join("\n")}` : message
}
