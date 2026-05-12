#!/usr/bin/env bun
/**
 * plan-archive.ts — Promote a spec to archived state.
 *
 * By default, archived specs stay in place (specs/<slug>/) with state="archived".
 * With --move-to-archive-folder, the folder is git mv'd to specs/archive/<slug>-YYYY-MM-DD/.
 *
 * Usage: bun run scripts/plan-archive.ts <path> [--move-to-archive-folder] [--reason "..."]
 *
 * Exit codes:
 *   0 — archived
 *   1 — illegal transition or failure
 *   2 — usage error
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { ensureNewFormat } from "./lib/ensure-new-format"
import {
  appendHistory,
  currentUser,
  nowIso,
  readState,
  writeState,
  type HistoryEntry,
} from "./lib/state"

function usage(exitCode = 2): never {
  console.error(
    `Usage: bun run plan-archive.ts <path> [--move-to-archive-folder] [--reason "..."]`,
  )
  process.exit(exitCode)
}

function dateTag(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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

function main(): void {
  const args = process.argv.slice(2)
  const positional: string[] = []
  let moveToArchiveFolder = false
  let reason = ""
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--move-to-archive-folder") moveToArchiveFolder = true
    else if (arg === "--reason") reason = args[++i] ?? ""
    else if (arg.startsWith("--reason=")) reason = arg.slice("--reason=".length)
    else if (!arg.startsWith("--")) positional.push(arg)
  }
  if (positional.length !== 1) usage()
  const inputPath = positional[0]!

  if (!existsSync(inputPath)) {
    console.error(`plan-archive: path does not exist: ${inputPath}`)
    process.exit(1)
  }

  const { finalPath } = ensureNewFormat(inputPath)
  const state = readState(finalPath)

  if (state.state === "archived") {
    console.error(`plan-archive: already archived`)
    process.exit(0)
  }

  if (state.state !== "living") {
    console.error(
      `plan-archive: can only archive from 'living' state; current state is '${state.state}'. ` +
        `Promote to living first (or use refactor if you intend to rewrite).`,
    )
    process.exit(1)
  }

  if (!reason) {
    console.error(`plan-archive: --reason is required`)
    process.exit(2)
  }

  const entry: HistoryEntry = {
    from: "living",
    to: "archived",
    at: nowIso(),
    by: currentUser(),
    mode: "archive",
    reason,
  }
  const updated = appendHistory({ ...state, state: "archived" }, entry)
  writeState(finalPath, updated)
  console.error(`plan-archive: state → archived`)

  let newLocation = finalPath
  if (moveToArchiveFolder) {
    const gitRoot = gitRootOf(finalPath)
    if (!gitRoot) {
      console.error(`plan-archive: --move-to-archive-folder requires a git working tree`)
      process.exit(1)
    }
    const slug = path.basename(finalPath)
    const archiveRoot = path.join(gitRoot, "specs", "archive")
    mkdirSync(archiveRoot, { recursive: true })
    const destination = path.join(archiveRoot, `${slug}-${dateTag()}`)
    if (existsSync(destination)) {
      console.error(`plan-archive: ${destination} already exists; refusing to overwrite`)
      process.exit(1)
    }
    const srcRel = path.relative(gitRoot, finalPath)
    const dstRel = path.relative(gitRoot, destination)
    try {
      execFileSync("git", ["-C", gitRoot, "mv", srcRel, dstRel], {
        stdio: ["ignore", "pipe", "inherit"],
      })
      console.error(`plan-archive: git mv ${srcRel} → ${dstRel}`)
      newLocation = destination
    } catch (e) {
      console.error(`plan-archive: git mv failed: ${(e as Error).message}`)
      process.exit(1)
    }
  }

  console.log(JSON.stringify({ path: newLocation, state: "archived" }, null, 2))
}

main()
