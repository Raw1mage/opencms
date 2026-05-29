#!/usr/bin/env bun
/**
 * sync-from-cli — verify @opencode-ai/provider-claude against the real
 * Claude Code CLI (`@anthropic-ai/claude-code`) native binary.
 *
 * The provider impersonates the official CLI's wire fingerprint (OAuth client,
 * scopes, headers, beta flags) and replicates its model catalog + max-output
 * logic. Those constants drift every CLI release. This script is the long-term
 * source-sync mechanism that replaced the (removed) `refs/claude-code` git
 * submodule — that submodule only ever vendored docs; the protocol truth lives
 * in the minified native binary published per-platform on npm.
 *
 * What it does:
 *   1. `npm pack` the pinned per-platform binary package into an XDG-private
 *      temp dir (never system /tmp), extracts the native `claude` binary.
 *   2. Greps the binary for the signature constants + model IDs + the LMH()
 *      max-output table.
 *   3. Diffs them against this package's source of truth (protocol.ts/models.ts).
 *   4. Prints a per-field PASS/DRIFT report. Exits non-zero on any drift.
 *
 * Usage:
 *   bun scripts/sync-from-cli.ts                 # uses PINNED_VERSION
 *   bun scripts/sync-from-cli.ts --version 2.1.160
 *   bun scripts/sync-from-cli.ts --keep          # keep the extracted binary
 *
 * To bump the pin: change PINNED_VERSION, run, then reconcile any DRIFT into
 * protocol.ts / models.ts and re-run until clean.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, mkdirSync, rmSync, readdirSync, statSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { arch } from "node:os"

import {
  VERSION,
  CLIENT_ID,
  ATTRIBUTION_SALT,
  API_VERSION,
  AUTHORIZE_SCOPES,
  REFRESH_SCOPES,
  OAUTH,
  BETA_CLAUDE_CODE,
  BETA_OAUTH,
} from "../src/protocol.js"
import { MODEL_CATALOG, getOutputLimit, normalizeModelId } from "../src/models.js"

/** The CLI version this provider is currently aligned to. Bump deliberately. */
const PINNED_VERSION = "2.1.156"

const args = process.argv.slice(2)
const versionArg = args.includes("--version") ? args[args.indexOf("--version") + 1] : undefined
const VERSION_TO_CHECK = versionArg ?? PINNED_VERSION
const KEEP = args.includes("--keep")

function platformKey(): string {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error(`unsupported platform for sync: ${process.platform}`)
  const cpu = arch() === "x64" ? "x64" : arch()
  return `${process.platform}-${cpu}`
}

// ── results ────────────────────────────────────────────────────────────────
let drift = 0
const rows: Array<[string, string, string]> = [] // [field, status, detail]
function check(field: string, ok: boolean, detail = "") {
  rows.push([field, ok ? "PASS" : "DRIFT", detail])
  if (!ok) drift++
}

// ── fetch + extract binary ──────────────────────────────────────────────────
const work = join(process.env.XDG_RUNTIME_DIR || join(process.env.HOME!, ".cache"), "claude-work", "provider-claude-sync")
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
chmodSync(work, 0o700)

const pkg = `@anthropic-ai/claude-code-${platformKey()}@${VERSION_TO_CHECK}`
console.log(`▸ npm pack ${pkg}`)
const tgz = execFileSync("npm", ["pack", pkg, "--silent"], { cwd: work, encoding: "utf8" }).trim().split("\n").pop()!
execFileSync("tar", ["xzf", tgz], { cwd: work })

// locate the largest executable file (the native binary)
function findBinary(dir: string): string {
  let best = ""
  let bestSize = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const inner = findBinary(p)
      if (inner) {
        const s = statSync(inner).size
        if (s > bestSize) (best = inner), (bestSize = s)
      }
    } else if (!/\.(cjs|json|md|ts|map)$/.test(e.name)) {
      const s = statSync(p).size
      if (s > bestSize) (best = p), (bestSize = s)
    }
  }
  return best
}
const binPath = findBinary(join(work, "package"))
console.log(`▸ binary: ${binPath} (${(statSync(binPath).size / 1e6).toFixed(0)} MB)\n`)
const bin = readFileSync(binPath, "latin1")
const has = (s: string) => bin.includes(s)

// ── 1. signature constants ───────────────────────────────────────────────────
check("VERSION (pinned vs binary)", has(`"${VERSION_TO_CHECK}"`), VERSION_TO_CHECK)
check(`provider VERSION const (${VERSION})`, VERSION === VERSION_TO_CHECK || has(`"${VERSION}"`), `provider=${VERSION}`)
check("CLIENT_ID", has(CLIENT_ID), CLIENT_ID)
check("ATTRIBUTION_SALT", has(ATTRIBUTION_SALT), ATTRIBUTION_SALT)
check("API_VERSION", has(API_VERSION), API_VERSION)
check("OAuth token endpoint", has(OAUTH.token.replace(/^https?:\/\//, "")), OAUTH.token)
for (const scope of AUTHORIZE_SCOPES.split(" ")) check(`scope ${scope}`, has(scope))
for (const scope of REFRESH_SCOPES) check(`refresh-scope ${scope}`, has(scope))
check(`beta ${BETA_CLAUDE_CODE}`, has(BETA_CLAUDE_CODE))
check(`beta ${BETA_OAUTH}`, has(BETA_OAUTH))

// ── 2. model catalog presence ─────────────────────────────────────────────────
const baseOf = (id: string) => id.replace(/-\d{8}$/, "")
for (const m of MODEL_CATALOG) {
  check(`model ${m.id}`, has(m.id) || has(baseOf(m.id)), m.name)
}
// any opus/sonnet/haiku 4.x model in the binary missing from our catalog?
// Informational only: the binary always carries `-4-0` date-aliases and
// unreleased canary IDs (e.g. `-4-2`) that we deliberately don't catalog.
const binModels = [...new Set((bin.match(/claude-(opus|sonnet|haiku)-4-\d(?:-\d{8})?/g) || []))]
const known = new Set(MODEL_CATALOG.flatMap((m) => [m.id, baseOf(m.id), normalizeModelId(m.id)]))
const missing = binModels.filter(
  (id) => !known.has(id) && !known.has(baseOf(id)) && !known.has(normalizeModelId(id)) && !/-4-0$/.test(id),
)
const noteModels = missing.length ? `NOTE: binary has uncatalogued 4.x IDs: ${missing.join(", ")}` : ""

// ── 3. LMH() max-output table ─────────────────────────────────────────────────
// upstream form:  if(K==="claude-opus-4-8")$=64000,q=128000; else if ...
const lmh = bin.match(/K==="(claude-[a-z0-9-]+)"\)\$=(\d+)/g) || []
const lmhPairs = lmh.map((s) => {
  const m = s.match(/K==="(claude-[a-z0-9-]+)"\)\$=(\d+)/)!
  return [m[1], Number(m[2])] as const
})
for (const [model, upstreamDefault] of lmhPairs) {
  const ours = getOutputLimit(model).default
  check(`max-output ${model}`, ours === upstreamDefault, `upstream=${upstreamDefault} ours=${ours}`)
}
check("LMH table extracted", lmhPairs.length > 0, `${lmhPairs.length} entries`)

// ── report ────────────────────────────────────────────────────────────────
const w = Math.max(...rows.map((r) => r[0].length))
console.log(`Sync report — provider-claude ↔ claude-code@${VERSION_TO_CHECK}\n`)
for (const [f, s, d] of rows) {
  const mark = s === "PASS" ? "✓" : "✗"
  console.log(`  ${mark} ${f.padEnd(w)}  ${s}${d ? "  " + d : ""}`)
}
if (noteModels) console.log(`\n  ${noteModels}`)
console.log(`\n${drift === 0 ? "✓ ALIGNED" : `✗ ${drift} DRIFT`} — checked ${rows.length} fields against ${VERSION_TO_CHECK}`)

if (!KEEP) rmSync(work, { recursive: true, force: true })
else console.log(`\n(kept: ${binPath})`)

process.exit(drift === 0 ? 0 : 1)
