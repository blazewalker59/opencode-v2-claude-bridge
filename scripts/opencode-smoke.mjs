#!/usr/bin/env node
// Plugin-load smoke test against a real OpenCode, with no Claude requests.
//
// Usage: node scripts/opencode-smoke.mjs [plugin]
//   plugin: a built plugin directory (default: ./dist), or a packed .tgz that
//   OpenCode installs itself, as it would for a user.
//
// OpenCode runs in a throwaway HOME, so the user's OpenCode configuration,
// sessions and background service are never touched. The plugin's
// `claudeExecutable` points at a file that does not exist, so model discovery
// falls back to the built-in aliases and every turn fails before any request
// leaves the machine. The run passes when OpenCode loaded the plugin,
// registered its provider, routed a turn through the bridge, and showed the
// missing-executable error once, without retrying it.
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const plugin = resolve(process.argv[2] ?? "dist")
const isTarball = plugin.endsWith(".tgz")
// OpenCode loads a local directory from its index.js (or server.js); it installs a tarball, and its dependencies, with npm.
const packageSpec = isTarball ? `file:${plugin}` : pathToFileURL(plugin).href
const opencode = process.env.OPENCODE_BIN ?? "opencode"
// Installing a tarball downloads its dependencies, so allow for a slow network.
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000)

if (isTarball ? !existsSync(plugin) : !existsSync(join(plugin, "index.js"))) {
  console.error(`No plugin at ${plugin}. Run \`npm run build\` first, or pass a built plugin directory or a packed .tgz.`)
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), "ocb-smoke-"))
const home = join(root, "home")
const workspace = join(root, "workspace")
const debugLog = join(root, "bridge.log")
const missingClaude = join(root, "no-claude-here")
mkdirSync(home)
mkdirSync(workspace)
spawnSync("git", ["init", "-q", workspace])
writeFileSync(
  join(workspace, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugins: [{ package: packageSpec, options: { claudeExecutable: missingClaude, debugLog } }],
    },
    null,
    2,
  ),
)

// Only what a process needs to run; everything else (credentials such as GITHUB_TOKEN or AWS_*,
// Anthropic and Claude Code settings, npm's own configuration under `npm run`) stays behind.
const PASSED = /^(PATH|PATHEXT|TMPDIR|TEMP|TMP|LANG|LC_[A-Z_]+|TERM|SHELL|USER|LOGNAME|SystemRoot|SYSTEMROOT|WINDIR|ComSpec|COMSPEC)$/
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => PASSED.test(name)))
Object.assign(env, {
  // OpenCode takes its project directory from $PWD, which Node would otherwise inherit from this process.
  PWD: workspace,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
})

// Ctrl-C: stop OpenCode (the "exit" handler in run() does that) and remove the throwaway home.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    process.once("exit", () => {
      if (!process.env.SMOKE_KEEP) rmSync(root, { recursive: true, force: true })
    })
    process.exit(130)
  })
}

const run = () =>
  new Promise((resolveRun) => {
    const child = spawn(opencode, ["run", "--standalone", "--model", "claude-agent-sdk/sonnet", "--format", "json", "Smoke test"], {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout can stop OpenCode's children too (POSIX).
      detached: process.platform !== "win32",
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    const kill = () => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL")
        else process.kill(-child.pid, "SIGKILL")
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(kill, timeoutMs)
    // A detached group no longer gets the terminal's Ctrl-C, so take it down if this script exits first.
    process.once("exit", kill)
    const settle = () => {
      clearTimeout(timer)
      process.removeListener("exit", kill)
      // Anything OpenCode started that outlived it.
      kill()
    }
    child.on("error", (error) => {
      settle()
      resolveRun({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut: false })
    })
    child.on("close", (code) => {
      settle()
      resolveRun({ code, stdout, stderr, timedOut: code === null })
    })
  })

const jsonLines = (text) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })

const failures = []
const check = (ok, description) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${description}`)
  if (!ok) failures.push(description)
}

let result
try {
  // A first standalone run occasionally stalls before loading plugins; one retry covers it.
  for (let attempt = 1; attempt <= 2; attempt++) {
    result = await run()
    if (!result.timedOut || result.stdout.length > 0) break
    console.log(`OpenCode produced no output within ${timeoutMs} ms; retrying once.`)
  }

  const events = jsonLines(result.stdout)
  const log = existsSync(debugLog) ? jsonLines(readFileSync(debugLog, "utf8")) : []
  const errors = events.filter((event) => event.type === "error")
  const primary = log.find((entry) => entry.event === "turn.start" && entry.kind === "primary")

  check(log.some((entry) => entry.event === "models.fallback"), "the plugin loaded and fell back to built-in models")
  check(primary?.model === "sonnet", "OpenCode routed the turn to claude-agent-sdk/sonnet through the bridge")
  check(Array.isArray(primary?.bridged) && primary.bridged.includes("read"), "OpenCode's read tool was bridged")
  check(errors.length === 1, `OpenCode showed exactly one error (saw ${errors.length})`)
  check(errors[0]?.error?.message?.includes(missingClaude) === true, "the error names the missing Claude Code executable")
  check(/claude --version/.test(errors[0]?.error?.message ?? ""), "the error carries the bridge's repair hint")
  check(errors[0]?.error?.type === "provider.invalid-request", `OpenCode classified it as not retryable (${errors[0]?.error?.type})`)
} finally {
  if (failures.length > 0 || process.env.SMOKE_KEEP) {
    console.log(`\nKept ${root} for inspection.`)
    if (result) console.log(`exit ${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`)
  } else {
    rmSync(root, { recursive: true, force: true })
  }
}

if (failures.length > 0) process.exit(1)
console.log(`\nOpenCode loaded the plugin from ${plugin}.`)
