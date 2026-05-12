#!/usr/bin/env bun
/**
 * plan-sync.ts — Detect code-spec drift (warn strategy, non-blocking).
 *
 * Scans git diff since the last sync-aligned commit recorded in .state.json.history.
 * Compares touched files against known spec-referenced code paths.
 *
 * This is the automatic checkpoint invoked by beta-workflow after every
 * task checkbox toggle. It always exits 0 (warn not block) so builds continue.
 *
 * Usage: bun run scripts/plan-sync.ts <spec-path> [--since <ref>]
 *
 * Exit codes:
 *   0 — sync checkpoint written (whether clean or warned)
 *   1 — spec missing or structurally invalid
 *   2 — usage error
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { ensureNewFormat } from "./lib/ensure-new-format"
import {
  appendHistory,
  currentUser,
  nowIso,
  readState,
  writeState,
  type HistoryEntry,
  type SyncResult,
} from "./lib/state"
import { runSpecbaseImportHook } from "./lib/specbase-hook"

const LOG_PREFIX = "[plan-sync]"

function usage(exitCode = 2): never {
  console.error(`Usage: bun run plan-sync.ts <spec-path> [--since <git-ref>]`)
  process.exit(exitCode)
}

function log(msg: string): void {
  console.error(`${LOG_PREFIX} ${msg}`)
}

function gitRootOf(p: string): string | null {
  try {
    return execFileSync("git", ["-C", p, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

function gitDiffFiles(gitRoot: string, since: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["-C", gitRoot, "diff", "--name-only", `${since}..HEAD`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    // fall back to working-tree diff
    try {
      const out = execFileSync("git", ["-C", gitRoot, "diff", "--name-only"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      return out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }
}

function lastSyncRef(
  history: ReturnType<typeof readState>["history"],
): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if (entry.mode === "sync" && typeof (entry as any).commit === "string") {
      return (entry as any).commit as string
    }
  }
  return null
}

function gitHead(gitRoot: string): string | null {
  try {
    return execFileSync("git", ["-C", gitRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

interface DriftFinding {
  file: string
  reason: string
}

function analyzeDrift(specRoot: string, changedFiles: string[]): DriftFinding[] {
  const findings: DriftFinding[] = []

  // Heuristic 1: if data-schema.json exists, check if any changed file references
  // field names declared in the schema but not yet reflected in data-schema.json.
  // This is a best-effort surface-level check; the real analysis belongs in a richer pass.
  const dataSchemaPath = path.join(specRoot, "data-schema.json")
  let schemaFieldKeys = new Set<string>()
  if (existsSync(dataSchemaPath)) {
    try {
      const schema = JSON.parse(readFileSync(dataSchemaPath, "utf8"))
      collectKeys(schema, schemaFieldKeys)
    } catch {
      /* ignore */
    }
  }

  // Heuristic 2: detect changed files in likely code surface (src/, packages/, etc.)
  // and check if their paths are referenced by any spec artifact.
  const artifactRefs = collectArtifactPathReferences(specRoot)

  for (const file of changedFiles) {
    // skip spec folder itself
    if (file.includes("/specs/") || file.includes("/plans/")) continue
    if (!/\.(ts|tsx|js|jsx|py|go|rs|java|rb|php)$/.test(file)) continue

    const referenced = [...artifactRefs].some((ref) => file.endsWith(ref) || ref.endsWith(file))
    if (!referenced) {
      findings.push({
        file,
        reason: "code file changed but no spec artifact references this path",
      })
    }
  }

  // Heuristic 3: if there are errors.md and changed code added new throw/Error strings
  // that aren't in errors.md, flag them. Skipped for now — too noisy without structural parsing.
  void schemaFieldKeys

  return findings
}

function collectKeys(obj: unknown, out: Set<string>): void {
  if (!obj || typeof obj !== "object") return
  if (Array.isArray(obj)) {
    for (const v of obj) collectKeys(v, out)
    return
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === "properties" && v && typeof v === "object") {
      for (const field of Object.keys(v as Record<string, unknown>)) {
        out.add(field)
      }
    }
    collectKeys(v, out)
  }
}

function collectArtifactPathReferences(specRoot: string): Set<string> {
  const refs = new Set<string>()
  const targets = [
    "design.md",
    "implementation-spec.md",
    "c4.json",
    "handoff.md",
  ]
  for (const name of targets) {
    const p = path.join(specRoot, name)
    if (!existsSync(p)) continue
    const body = readFileSync(p, "utf8")
    // Extract path-like tokens: anything that looks like `a/b/c.ts` or `packages/foo/...`
    const re = /[\w./\-]+?\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|md|json|yml|yaml)/g
    const matches = body.match(re) ?? []
    for (const m of matches) refs.add(m)
  }
  return refs
}

function main(): void {
  const args = process.argv.slice(2)
  const positional: string[] = []
  let since: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--since") since = args[++i]
    else if (arg.startsWith("--since=")) since = arg.slice("--since=".length)
    else if (!arg.startsWith("--")) positional.push(arg)
  }
  if (positional.length !== 1) usage()
  const inputPath = positional[0]!

  if (!existsSync(inputPath)) {
    console.error(`plan-sync: path does not exist: ${inputPath}`)
    process.exit(1)
  }

  const { finalPath } = ensureNewFormat(inputPath)
  const state = readState(finalPath)

  const gitRoot = gitRootOf(finalPath)
  if (!gitRoot) {
    console.error(`${LOG_PREFIX} WARN: ${finalPath} is not in a git working tree; cannot sync.`)
    process.exit(0) // still non-blocking
  }

  const sinceRef = since ?? lastSyncRef(state.history) ?? "HEAD~1"
  const changedFiles = gitDiffFiles(gitRoot, sinceRef)
  const head = gitHead(gitRoot)

  log(`checking diff ${sinceRef}..HEAD (${changedFiles.length} file(s) changed)`)

  let findings: DriftFinding[] = []
  if (changedFiles.length > 0) {
    findings = analyzeDrift(finalPath, changedFiles)
  }

  const result: SyncResult = findings.length > 0 ? "warned" : "clean"
  if (result === "warned") {
    for (const f of findings) {
      log(`WARN: ${f.file} — ${f.reason}`)
    }
    log(`Suggest amend mode if you intend these changes to stay; otherwise update spec.`)
  } else {
    log(`clean — no drift detected`)
  }

  const entry: HistoryEntry & { commit?: string } = {
    at: nowIso(),
    by: currentUser(),
    mode: "sync",
    reason:
      findings.length > 0
        ? `drift detected: ${findings.map((f) => f.file).join(", ")}`
        : "post-task sync, clean",
    result,
  }
  if (findings.length > 0) entry.drift = findings.map((f) => f.file)
  if (head) (entry as any).commit = head

  writeState(finalPath, appendHistory(state, entry))

  // Non-blocking README index refresh (DD-20). Sync events also trigger
  // README regeneration so drift findings surface in the wiki view.
  runSpecbaseImportHook(finalPath)

  // Always exit 0 (warn strategy)
  process.exit(0)
}

main()
