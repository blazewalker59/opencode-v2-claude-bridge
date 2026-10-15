#!/usr/bin/env node
// Release-artifact check: check what the plugin tarball contains, then have a
// real OpenCode install it and load the plugin from it, the way a user would,
// rather than from this checkout.
//
// Usage: node scripts/package-smoke.mjs [tarball]
//   tarball: a packed .tgz to check (the release job passes the exact file it
//   publishes). Without one, the package is packed into a temporary directory.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = join(dirname(fileURLToPath(import.meta.url)), "..")
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const given = process.argv[2] && resolve(process.argv[2])
const root = given ? undefined : mkdtempSync(join(tmpdir(), "ocb-package-"))

/** Paths inside the tarball, without npm's `package/` prefix. */
const tarballFiles = (tarball) =>
  execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
    .map((entry) => entry.replace(/^package\//, ""))
    .sort()

try {
  let tarball = given
  if (!tarball) {
    // `prepack` builds dist, so the tarball never depends on a stale local build.
    const [packed] = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", root], { cwd: repo, encoding: "utf8" }))
    tarball = join(root, packed.filename)
  }
  const files = tarballFiles(tarball)
  console.log(`Checking ${tarball} (${files.length} files, ${statSync(tarball).size} bytes)`)

  const unexpected = files.filter((path) => !/^(dist\/.+\.(js|d\.ts)|README\.md|LICENSE|CHANGELOG\.md|package\.json)$/.test(path))
  const required = ["dist/index.js", "package.json", "README.md", "LICENSE", "CHANGELOG.md"].filter((path) => !files.includes(path))
  if (unexpected.length > 0 || required.length > 0) {
    throw new Error(`Unexpected files: ${unexpected.join(", ") || "none"}; missing: ${required.join(", ") || "none"}`)
  }

  execFileSync(process.execPath, [join(repo, "scripts", "opencode-smoke.mjs"), tarball], { stdio: "inherit" })
} finally {
  if (root && process.env.SMOKE_KEEP) console.log(`Kept ${root} for inspection.`)
  else if (root) rmSync(root, { recursive: true, force: true })
}
