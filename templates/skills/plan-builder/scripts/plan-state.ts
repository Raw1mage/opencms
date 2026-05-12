#!/usr/bin/env bun
/**
 * plan-state.ts — Print the current state of a spec. Auto-migrates legacy plans/<slug>/ on touch.
 *
 * Usage:
 *   bun run scripts/plan-state.ts <path>
 *   bun run scripts/plan-state.ts <path> --json   (machine-readable output)
 *
 * Exit codes:
 *   0 — state printed successfully
 *   1 — spec not found / migration failed
 *   2 — usage error
 */

import { existsSync } from "node:fs"
import path from "node:path"
import { ensureNewFormat } from "./lib/ensure-new-format"
import { readState } from "./lib/state"

function usage(exitCode = 2): never {
  console.error(`Usage: bun run plan-state.ts <path> [--json]`)
  process.exit(exitCode)
}

function main(): void {
  const args = process.argv.slice(2)
  const json = args.includes("--json")
  const positional = args.filter((a) => !a.startsWith("--"))
  if (positional.length !== 1) usage()
  const inputPath = positional[0]!

  if (!existsSync(inputPath)) {
    console.error(`plan-state: path does not exist: ${inputPath}`)
    process.exit(1)
  }

  const result = ensureNewFormat(inputPath)
  const state = readState(result.finalPath)

  if (json) {
    console.log(
      JSON.stringify(
        {
          path: result.finalPath,
          state: state.state,
          profile: state.profile,
          migrated: result.changed,
          inferredState: result.inferredState,
          historyLength: state.history.length,
        },
        null,
        2,
      ),
    )
  } else {
    console.log(`Path: ${path.relative(process.cwd(), result.finalPath) || result.finalPath}`)
    console.log(`State: ${state.state}`)
    if (state.profile.length > 0) console.log(`Profile: ${state.profile.join(", ")}`)
    console.log(`History entries: ${state.history.length}`)
    if (result.changed) {
      console.log(`(This path was migrated from legacy format to ${result.finalPath})`)
    }
  }
}

main()
