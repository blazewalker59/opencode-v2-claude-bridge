import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { MAX_FILE_CHARS, MAX_TOTAL_CHARS, readInstructions } from "../src/instructions.js"

/** A home directory containing a repository at home/repo with a package at home/repo/pkg. */
const withTree = async (body: (paths: { home: string; repo: string; pkg: string; env: NodeJS.ProcessEnv }) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-instructions-"))
  const home = join(root, "home")
  const repo = join(home, "repo")
  const pkg = join(repo, "pkg")
  await mkdir(join(repo, ".git"), { recursive: true })
  await mkdir(pkg, { recursive: true })
  try {
    await body({ home, repo, pkg, env: {} })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("no instruction files means nothing is appended", async () => {
  await withTree(async ({ home, pkg, env }) => {
    const result = await readInstructions(pkg, home, env)
    assert.equal(result.text, undefined)
    assert.deepEqual(result.files, [])
  })
})

test("files are collected from the global file down to the working directory, most specific last", async () => {
  await withTree(async ({ home, repo, pkg, env }) => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true })
    await writeFile(join(home, ".config", "opencode", "AGENTS.md"), "global rule")
    await writeFile(join(repo, "AGENTS.md"), "repo rule")
    await writeFile(join(pkg, "CLAUDE.md"), "package rule")
    const result = await readInstructions(pkg, home, env)
    assert.deepEqual(result.files, [join(home, ".config", "opencode", "AGENTS.md"), join(repo, "AGENTS.md"), join(pkg, "CLAUDE.md")])
    const text = result.text ?? ""
    assert.ok(text.indexOf("global rule") < text.indexOf("repo rule") && text.indexOf("repo rule") < text.indexOf("package rule"))
    assert.match(text, new RegExp(`Instructions from ${join(repo, "AGENTS.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`))
  })
})

test("AGENTS.md wins over CLAUDE.md in the same directory, as in OpenCode", async () => {
  await withTree(async ({ home, repo, env }) => {
    await writeFile(join(repo, "AGENTS.md"), "agents")
    await writeFile(join(repo, "CLAUDE.md"), "claude")
    const result = await readInstructions(repo, home, env)
    assert.deepEqual(result.files, [join(repo, "AGENTS.md")])
    assert.doesNotMatch(result.text ?? "", /claude/)
  })
})

test("the global file falls back to ~/.claude/CLAUDE.md and honours XDG_CONFIG_HOME", async () => {
  await withTree(async ({ home, repo }) => {
    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(join(home, ".claude", "CLAUDE.md"), "claude global")
    assert.deepEqual((await readInstructions(repo, home, {})).files, [join(home, ".claude", "CLAUDE.md")])

    const xdg = join(home, "xdg")
    await mkdir(join(xdg, "opencode"), { recursive: true })
    await writeFile(join(xdg, "opencode", "AGENTS.md"), "xdg global")
    assert.deepEqual((await readInstructions(repo, home, { XDG_CONFIG_HOME: xdg })).files, [join(xdg, "opencode", "AGENTS.md")])
  })
})

test("the walk stops at the repository root and never reads the home directory as a project", async () => {
  await withTree(async ({ home, repo, pkg, env }) => {
    await writeFile(join(home, "AGENTS.md"), "home file")
    await writeFile(join(repo, "..", "AGENTS.md"), "above the repo")
    const inRepo = await readInstructions(pkg, home, env)
    assert.deepEqual(inRepo.files, [])

    await rm(join(repo, ".git"), { recursive: true })
    const noRepo = await readInstructions(pkg, home, env)
    assert.deepEqual(noRepo.files, [], "without a repository the walk ends below home")
  })
})

test("oversized files are cut and reported, and the total stays within the limit", async () => {
  await withTree(async ({ home, repo, pkg, env }) => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true })
    await writeFile(join(home, ".config", "opencode", "AGENTS.md"), "g".repeat(MAX_FILE_CHARS + 10))
    await writeFile(join(repo, "AGENTS.md"), "r".repeat(MAX_FILE_CHARS + 10))
    await writeFile(join(pkg, "AGENTS.md"), "p")
    const result = await readInstructions(pkg, home, env)
    assert.equal(MAX_TOTAL_CHARS, 2 * MAX_FILE_CHARS, "this test fills the total with two files")
    assert.deepEqual(result.truncated, [join(home, ".config", "opencode", "AGENTS.md"), join(repo, "AGENTS.md"), join(pkg, "AGENTS.md")])
    assert.deepEqual(result.files, [join(home, ".config", "opencode", "AGENTS.md"), join(repo, "AGENTS.md")])
    assert.match(result.text ?? "", /\[Truncated: the rest of this file was left out\.\]/)
  })
})

test("an unreadable file is reported and skipped, never thrown", { skip: process.getuid?.() === 0 }, async () => {
  await withTree(async ({ home, repo, env }) => {
    const path = join(repo, "AGENTS.md")
    await writeFile(path, "secret")
    await chmod(path, 0o000)
    try {
      const result = await readInstructions(repo, home, env)
      assert.deepEqual(result.files, [])
      assert.equal(result.unreadable[0]?.path, path)
    } finally {
      await chmod(path, 0o600)
    }
  })
})
