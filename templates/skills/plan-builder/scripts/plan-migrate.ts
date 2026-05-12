#!/usr/bin/env bun
/**
 * plan-migrate.ts — Explicitly migrate a legacy plans/<slug>/ folder to specs/<slug>/.
 *
 * This is a thin wrapper around ensureNewFormat(). Use it when you want to
 * trigger migration without also running any other plan-builder operation.
 *
 * Usage: bun run scripts/plan-migrate.ts <legacy-path>
 *
 * Exit codes:
 *   0 — migrated (or already migrated; no-op)
 *   1 — migration failed (e.g. StateInferenceError, git mv failed)
 *   2 — usage error
 */

import { existsSync } from "node:fs"
import path from "node:path"
import { ensureNewFormat } from "./lib/ensure-new-format"
import { readState } from "./lib/state"

function usage(exitCode = 2): never {
  console.error(`Usage: bun run plan-migrate.ts <legacy-path>`)
  process.exit(exitCode)
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"))
  if (args.length !== 1) usage()
  const inputPath = args[0]!

  if (!existsSync(inputPath)) {
    console.error(`plan-migrate: path does not exist: ${inputPath}`)
    process.exit(1)
  }

  try {
    const result = ensureNewFormat(inputPath)
    const state = readState(result.finalPath)
    if (result.changed) {
      console.log(
        `Migrated: ${result.finalPath} (state=${state.state})`,
      )
    } else {
      console.log(
        `No migration needed: ${result.finalPath} already in new format (state=${state.state})`,
      )
    }
  } catch (e) {
    const err = e as Error
    console.error(`plan-migrate: FAILED — ${err.message}`)
    process.exit(1)
  }
}

main()
