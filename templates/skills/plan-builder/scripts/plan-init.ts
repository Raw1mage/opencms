#!/usr/bin/env bun
/**
 * plan-init.ts — Create a new spec package at plans/<flat-slug>/ with proposal.md
 * and .state.json (state=proposed).
 *
 * Slugs are slash-form ("compaction/codex-empty-turn"); the on-disk folder uses
 * underscore encoding ("plans/compaction_codex-empty-turn/"). The graduation
 * gate (`plan_graduate`) later moves the folder to /specs/<category>/<topic>/.
 *
 * Usage:
 *   bun run scripts/plan-init.ts <slug>                      # plans/<flat>/
 *   bun run scripts/plan-init.ts plans/<flat-slug>/          # explicit path
 *   bun run scripts/plan-init.ts <slug> [--profile=ssdlc]
 *
 * Exit codes:
 *   0 — created (or already exists and no --force)
 *   2 — usage error
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  currentUser,
  nowIso,
  stateFilePath,
  writeState,
  type StateFile,
} from "./lib/state"
import { runSpecbaseImportHook } from "./lib/specbase-hook"

function usage(exitCode = 2): never {
  console.error(
    `Usage: bun run plan-init.ts <slug-or-path> [--profile=ssdlc]

Creates plans/<flat-slug>/proposal.md and .state.json with state=proposed.
Slug "compaction/codex-empty-turn" → folder "plans/compaction_codex-empty-turn/".
If <slug-or-path> contains a path separator, the path is used verbatim.`,
  )
  process.exit(exitCode)
}

function parseArgs(argv: string[]): { target: string; profile: string[] } {
  const positional: string[] = []
  const profile: string[] = []
  for (const arg of argv) {
    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length)
      profile.push(...value.split(",").map((s) => s.trim()).filter(Boolean))
    } else if (arg === "--help" || arg === "-h") {
      usage(0)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length !== 1) usage()
  return { target: positional[0]!, profile }
}

function flattenSlug(slug: string): string {
  return slug.replaceAll("/", "_")
}

function resolveSpecRoot(target: string): string {
  // Explicit path (contains separator and is not a bare slug like "compaction/foo"):
  // anything starting with "./", "/", "plans/", "specs/" is treated as a path.
  if (target.startsWith("./") || target.startsWith("/") || target.startsWith("plans/") || target.startsWith("specs/")) {
    return path.resolve(target)
  }
  // Bare slug — encode "/" as "_" and land under plans/.
  return path.resolve("plans", flattenSlug(target))
}

function proposalSkeleton(slug: string): string {
  return `# Proposal: ${slug}

## Why

- <why this work exists — problem / opportunity / pressure>

## Original Requirement Wording (Baseline)

- "<user's original words, recorded faithfully>"

## Requirement Revision History

- ${new Date().toISOString().slice(0, 10)}: initial draft created via plan-init.ts

## Effective Requirement Description

1. <current effective requirement>

## Scope

### IN
- <in scope>

### OUT
- <out of scope>

## Non-Goals

- <explicitly not being solved>

## Constraints

- <technical / product / policy constraint>

## What Changes

- <what will change>

## Capabilities

### New Capabilities
- <capability>: <brief description>

### Modified Capabilities
- <existing capability>: <behavior delta>

## Impact

- <affected code, APIs, systems, operators, or docs>
`
}

function main(): void {
  const { target, profile } = parseArgs(process.argv.slice(2))
  const specRoot = resolveSpecRoot(target)
  const slug = path.basename(specRoot)

  if (existsSync(stateFilePath(specRoot))) {
    console.error(`plan-init: ${specRoot} already has .state.json; refusing to overwrite`)
    process.exit(1)
  }

  mkdirSync(specRoot, { recursive: true })

  const proposalPath = path.join(specRoot, "proposal.md")
  if (!existsSync(proposalPath)) {
    writeFileSync(proposalPath, proposalSkeleton(slug), "utf8")
    console.error(`plan-init: wrote ${proposalPath}`)
  } else {
    console.error(`plan-init: proposal.md already exists, leaving untouched`)
  }

  const state: StateFile = {
    schema_version: 1,
    state: "proposed",
    profile,
    history: [
      {
        from: null,
        to: "proposed",
        at: nowIso(),
        by: currentUser(),
        mode: "new",
        reason: `initial spec created via plan-init.ts${profile.length ? ` (profile=${profile.join(",")})` : ""}`,
      },
    ],
  }
  writeState(specRoot, state)
  console.error(`plan-init: wrote ${stateFilePath(specRoot)} {state: "proposed"}`)

  // Non-blocking README index refresh (DD-20). README is the topic's
  // wiki entry from day 1; subsequent edits keep regenerating it.
  runSpecbaseImportHook(specRoot)

  console.log(specRoot)
}

main()
