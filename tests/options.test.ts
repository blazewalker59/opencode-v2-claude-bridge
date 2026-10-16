import assert from "node:assert/strict"
import test from "node:test"
import { parsePluginOptions, resolveWorkingDirectory } from "../src/options.js"

test("defaults are read-only tools and haiku titles", () => {
  assert.deepEqual(parsePluginOptions(undefined), {
    toolPolicy: "read-only",
    models: undefined,
    titleModel: "haiku",
    claudeExecutable: undefined,
    debugLog: undefined,
    workingDirectory: undefined,
    claudeDebugDir: undefined,
  })
})

test("valid options are accepted", () => {
  assert.deepEqual(
    parsePluginOptions({
      toolPolicy: "opencode",
      models: ["sonnet", "opus"],
      titleModel: "sonnet",
      claudeExecutable: "/opt/claude/bin/claude",
      debugLog: "/tmp/bridge.log",
      workingDirectory: "packages/api",
      claudeDebugDir: "/tmp/claude-debug",
    }),
    {
      toolPolicy: "opencode",
      models: ["sonnet", "opus"],
      titleModel: "sonnet",
      claudeExecutable: "/opt/claude/bin/claude",
      debugLog: "/tmp/bridge.log",
      workingDirectory: "packages/api",
      claudeDebugDir: "/tmp/claude-debug",
    },
  )
})

test("malformed options stop the plugin with a message naming the option", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ toolpolicy: "opencode" }, /Unknown plugin option toolpolicy/],
    [{ toolPolicy: "all" }, /Invalid toolPolicy/],
    [{ models: [] }, /models must be a non-empty array/],
    [{ models: "sonnet" }, /models must be a non-empty array/],
    [{ models: ["sonnet", ""] }, /models\[1\] must be a non-empty string/],
    [{ titleModel: 3 }, /titleModel must be a non-empty string/],
    [{ claudeExecutable: "bin/claude" }, /claudeExecutable must be an absolute path/],
    [{ debugLog: "bridge.log" }, /debugLog must be an absolute path/],
    [{ workingDirectory: "" }, /workingDirectory must be a non-empty string/],
    [{ claudeDebugDir: "logs" }, /claudeDebugDir must be an absolute path/],
  ]
  for (const [input, message] of cases) assert.throws(() => parsePluginOptions(input), message)
})

test("the working directory defaults to the OpenCode project", () => {
  assert.equal(resolveWorkingDirectory("/repo/app", undefined, () => false), "/repo/app")
})

test("a relative working directory resolves against each project", () => {
  const exists = (path: string) => ["/repo", "/repo/app/packages/api"].includes(path)
  assert.equal(resolveWorkingDirectory("/repo/app", "packages/api", exists), "/repo/app/packages/api")
  assert.equal(resolveWorkingDirectory("/repo/app", "..", exists), "/repo")
  assert.equal(resolveWorkingDirectory("/elsewhere", "/repo", exists), "/repo", "absolute paths are taken as given")
})

test("a working directory that does not exist stops the plugin from loading", () => {
  assert.throws(() => resolveWorkingDirectory("/repo/app", "pakages/api", () => false), /resolves to \/repo\/app\/pakages\/api, which is not an existing directory/)
})

test("a repeated model ID is listed once", () => {
  assert.deepEqual(parsePluginOptions({ models: ["sonnet", "haiku", "sonnet"] }).models, ["sonnet", "haiku"])
})

test("model IDs are trimmed", () => {
  const options = parsePluginOptions({ models: [" sonnet", "haiku ", "sonnet"], titleModel: " haiku " })
  assert.deepEqual(options.models, ["sonnet", "haiku"])
  assert.equal(options.titleModel, "haiku")
})
