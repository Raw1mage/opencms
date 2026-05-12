#!/usr/bin/env bun
/**
 * plan-promote.ts — Advance state or apply a non-forward mode (amend / revise / extend / refactor / archive).
 *
 * Usage:
 *   bun run scripts/plan-promote.ts <path> --to <state> [--reason "..."]
 *   bun run scripts/plan-promote.ts <path> --mode <mode> [--reason "..."]
 *
 * If --to is used, mode defaults to "promote" and must match the natural forward transition.
 * If --mode is used, the transition is derived from the mode (see lib/state.ts transitionFor).
 *
 * Exit codes:
 *   0 — promoted
 *   1 — validation blocker or illegal transition
 *   2 — usage error
 */

import { existsSync } from "node:fs"
import path from "node:path"
import { ensureNewFormat } from "./lib/ensure-new-format"
import { runSpecbaseImportHook } from "./lib/specbase-hook"
import {
  appendHistory,
  currentUser,
  nowIso,
  readState,
  transitionFor,
  writeState,
  type HistoryEntry,
  type Mode,
  type State,
} from "./lib/state"
import { snapshotForRefactor } from "./lib/snapshot"

function usage(exitCode = 2): never {
  console.error(
    `Usage:
  plan-promote.ts <path> --to <state> [--reason "..."]
  plan-promote.ts <path> --mode <mode> [--reason "..."] [--to <state-for-system-modes>]

Modes: new, promote, amend, revise, extend, refactor, sync, archive`,
  )
  process.exit(exitCode)
}

interface Args {
  path: string
  to?: State
  mode?: Mode
  reason: string
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  let to: string | undefined
  let mode: string | undefined
  let reason: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--to") {
      to = argv[++i]
    } else if (arg === "--mode") {
      mode = argv[++i]
    } else if (arg === "--reason") {
      reason = argv[++i]
    } else if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length)
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length)
    } else if (arg.startsWith("--reason=")) {
      reason = arg.slice("--reason=".length)
    } else {
      positional.push(arg)
    }
  }

  if (positional.length !== 1) usage()
  if (!to && !mode) usage()

  return {
    path: positional[0]!,
    to: to as State | undefined,
    mode: mode as Mode | undefined,
    reason: reason ?? "",
  }
}

function runValidate(specRoot: string, asState?: string): boolean {
  const scriptPath = path.join(__dirname, "plan-validate.ts")
  const args = ["run", scriptPath, specRoot]
  if (asState) args.push(`--as-state=${asState}`)
  try {
    execFileSync("bun", args, {
      stdio: ["ignore", "inherit", "inherit"],
    })
    return true
  } catch {
    return false
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.path)) {
    console.error(`plan-promote: path does not exist: ${args.path}`)
    process.exit(1)
  }

  const { finalPath } = ensureNewFormat(args.path)
  const state = readState(finalPath)
  const currentState = state.state

  // Resolve mode + target state
  let mode: Mode
  let targetState: State | null
  if (args.mode) {
    mode = args.mode
    targetState = transitionFor(mode, currentState, args.to)
  } else {
    mode = "promote"
    targetState = args.to ?? null
    const natural = transitionFor("promote", currentState)
    if (targetState !== natural) {
      console.error(
        `plan-promote: --to=${args.to} does not match natural promote transition ` +
          `(${currentState} → ${natural ?? "<none>"}). Use --mode to apply a non-forward transition.`,
      )
      process.exit(1)
    }
  }

  if (!targetState) {
    console.error(`plan-promote: illegal transition from state=${currentState} via mode=${mode}`)
    process.exit(1)
  }

  if (!args.reason && mode !== "sync") {
    console.error(`plan-promote: --reason is required for mode=${mode}`)
    process.exit(2)
  }

  // Validate artifacts against TARGET state before any state change.
  // This is the promotion gate: the spec must be ready for what it is becoming.
  // For `refactor` we skip because snapshot+reset is about to happen.
  // For `archive` we skip because archived just freezes current content.
  // For `sync` we skip because sync never changes state.
  if (mode !== "refactor" && mode !== "archive" && mode !== "sync") {
    if (!runValidate(finalPath, targetState)) {
      console.error(
        `plan-promote: artifacts do not satisfy target state=${targetState}; ` +
          `add/fix required artifacts before promoting.`,
      )
      process.exit(1)
    }
  }

  const entry: HistoryEntry = {
    from: currentState,
    to: targetState,
    at: nowIso(),
    by: currentUser(),
    mode,
    reason: args.reason || `mode=${mode}`,
  }

  // Mode-specific side effects
  if (mode === "refactor") {
    const snap = snapshotForRefactor(finalPath)
    entry.snapshot = snap.relativeFromRoot
    console.error(
      `plan-promote: snapshotted ${snap.movedFiles.length} artifact(s) to ${snap.relativeFromRoot}`,
    )
  }

  const next = appendHistory({ ...state, state: targetState }, entry)
  writeState(finalPath, next)
  console.error(
    `plan-promote: ${currentState} → ${targetState} (mode=${mode})`,
  )

  // Non-blocking README refresh after every state change (DD-6, DD-20).
  // Was originally gated on targetState === "living"; now fires every
  // transition so the wiki view stays current through the whole lifecycle.
  runSpecbaseImportHook(finalPath)

  console.log(JSON.stringify({ path: finalPath, state: targetState, mode }, null, 2))
}

// Hook helper extracted to lib/specbase-hook.ts so plan-init.ts and
// plan-sync.ts can share it.

main()
