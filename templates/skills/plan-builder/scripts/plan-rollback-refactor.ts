#!/usr/bin/env bun
/**
 * plan-rollback-refactor.ts — Restore artifacts from the most recent
 * .history/refactor-*/ snapshot, undoing a refactor operation.
 *
 * Usage: bun run scripts/plan-rollback-refactor.ts <spec-path> [--from <snapshot-name>]
 *
 * Exit codes:
 *   0 — rollback complete
 *   1 — no snapshot found or rollback failed
 *   2 — usage error
 */

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { ensureNewFormat } from "./lib/ensure-new-format"
import {
  appendHistory,
  currentUser,
  nowIso,
  readState,
  writeState,
  type HistoryEntry,
  type State,
} from "./lib/state"
import { findLatestRefactorSnapshot } from "./lib/snapshot"

function usage(exitCode = 2): never {
  console.error(
    `Usage: bun run plan-rollback-refactor.ts <spec-path> [--from <refactor-YYYY-MM-DD>]`,
  )
  process.exit(exitCode)
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

function priorStateBeforeRefactor(history: readonly HistoryEntry[]): State | null {
  // Find the most recent refactor entry; its `from` was the pre-refactor state.
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!
    if (e.mode === "refactor") return (e.from as State) ?? null
  }
  return null
}

function main(): void {
  const args = process.argv.slice(2)
  const positional: string[] = []
  let fromOverride: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--from") fromOverride = args[++i]
    else if (arg.startsWith("--from=")) fromOverride = arg.slice("--from=".length)
    else if (!arg.startsWith("--")) positional.push(arg)
  }
  if (positional.length !== 1) usage()
  const inputPath = positional[0]!

  if (!existsSync(inputPath)) {
    console.error(`plan-rollback-refactor: path does not exist: ${inputPath}`)
    process.exit(1)
  }

  const { finalPath } = ensureNewFormat(inputPath)
  const state = readState(finalPath)

  const snapshotPath = fromOverride
    ? path.join(finalPath, ".history", fromOverride)
    : findLatestRefactorSnapshot(finalPath)

  if (!snapshotPath || !existsSync(snapshotPath)) {
    console.error(
      `plan-rollback-refactor: no refactor snapshot found` +
        (fromOverride ? ` matching ${fromOverride}` : ""),
    )
    process.exit(1)
  }

  const restoredFromRel = path.relative(finalPath, snapshotPath)
  console.error(`plan-rollback-refactor: restoring from ${restoredFromRel}`)

  const gitRoot = gitRootOf(finalPath)
  if (!gitRoot) {
    console.error(`plan-rollback-refactor: not in a git working tree; refuse to modify files`)
    process.exit(1)
  }

  // 1. Delete any current artifacts that were the post-refactor skeleton
  //    (anything in specRoot except proposal.md, .state.json, .history/, .archive/)
  for (const entry of readdirSync(finalPath)) {
    if ([".state.json", "proposal.md", ".history", ".archive"].includes(entry)) continue
    const target = path.join(finalPath, entry)
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (e) {
      console.error(`plan-rollback-refactor: failed to remove ${target}: ${(e as Error).message}`)
      process.exit(1)
    }
  }

  // 2. Move snapshot contents back up to finalPath
  for (const entry of readdirSync(snapshotPath)) {
    const from = path.join(snapshotPath, entry)
    const to = path.join(finalPath, entry)
    const fromRel = path.relative(gitRoot, from)
    const toRel = path.relative(gitRoot, to)
    try {
      execFileSync("git", ["-C", gitRoot, "mv", fromRel, toRel], {
        stdio: ["ignore", "pipe", "inherit"],
      })
    } catch {
      // Fall back for untracked entries
      try {
        execFileSync("mv", [from, to])
      } catch (e) {
        console.error(
          `plan-rollback-refactor: failed to move ${fromRel} back: ${(e as Error).message}`,
        )
        process.exit(1)
      }
    }
  }

  // 3. Remove empty snapshot folder
  try {
    const remaining = readdirSync(snapshotPath)
    if (remaining.length === 0) rmSync(snapshotPath, { recursive: true })
  } catch {
    /* ignore */
  }

  // 4. Append history entry and restore previous state
  const prior = priorStateBeforeRefactor(state.history) ?? "living"
  const entry: HistoryEntry = {
    from: state.state,
    to: prior,
    at: nowIso(),
    by: currentUser(),
    mode: "refactor-rollback",
    reason: `restored from ${restoredFromRel}`,
    "restored-from": restoredFromRel,
  }
  writeState(finalPath, appendHistory({ ...state, state: prior }, entry))
  console.error(`plan-rollback-refactor: state ${state.state} → ${prior}; restored ${restoredFromRel}`)
  console.log(
    JSON.stringify({ path: finalPath, state: prior, restoredFrom: restoredFromRel }, null, 2),
  )
}

main()
