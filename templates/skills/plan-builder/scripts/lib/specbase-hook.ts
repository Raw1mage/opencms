/**
 * Shared post-action hook: ask the plan-builder MCP (specbase's
 * importFromPlan CLI) to refresh the README index for a package.
 *
 * Used by plan-init.ts, plan-promote.ts, plan-sync.ts and any other
 * action that mutates a `specs/<slug>/` package. Fires on every change
 * (not just `living`) so the wiki view always reflects current state —
 * the user's stage-3 sync pain disappears because every plan-builder
 * action keeps the README in sync.
 *
 * Failures are non-blocking by design (DD-6): the plan-builder action's
 * exit code is the contract; the README refresh is a side-effect.
 *
 * Silent no-op if the CLI isn't on this machine (different setups, CI,
 * etc.) — pin a path with SPECBASE_CLI_PATH or set SPECBASE_DISABLE_HOOK=1
 * to opt out entirely.
 */

import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"

export function runSpecbaseImportHook(packagePath: string): void {
  if (process.env.SPECBASE_DISABLE_HOOK?.trim() === "1") return

  const cliPath = process.env.SPECBASE_CLI_PATH?.trim() ||
    `${process.env.HOME ?? ""}/projects/specbase/packages/lib/src/cli/import-from-plan.ts`
  if (!existsSync(cliPath)) {
    return // specbase not present on this machine — silent no-op
  }
  try {
    execFileSync("bun", [cliPath, packagePath], {
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 30_000,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`plan-builder: specbase README sync failed (non-blocking): ${msg}`)
  }
}
