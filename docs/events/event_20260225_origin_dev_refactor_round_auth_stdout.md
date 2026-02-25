# Event: origin/dev refactor round (auth login stdout concurrency)

Date: 2026-02-25
Status: Done

## 1. Context

- Request: routine `refacting_merger` catch-up for latest `origin/dev` commits and include relevant functionality into `cms`.
- Constraint: per project architecture, no direct merge/cherry-pick from `origin/dev`; only analyzed refactor-port is allowed.

## 2. Source delta inspected

- Latest upstream head: `088a81c116f3fda865851292c92754385292b92d`
- Previous reviewed anchor from event log: `aaf8317c8`
- Inspected range: `aaf8317c8..origin/dev`

## 3. Adopted item (refactor-port)

1. `088a81c11` fix: consume stdout concurrently with process exit in auth login
   - Risk addressed: potential deadlock/race when waiting process exit before draining stdout pipe.
   - `cms` adaptation:
     - keep existing `Bun.spawn` implementation in `packages/opencode/src/cli/cmd/auth.ts`
     - read stdout text and wait exit concurrently via `Promise.all([proc.exited, new Response(proc.stdout).text()])`
     - add explicit `proc.stdout` guard.

## 4. Files changed in cms

- `packages/opencode/src/cli/cmd/auth.ts`

## 5. Notes

- This round intentionally focused on the latest high-value low-blast-radius bugfix at `origin/dev` tip.
- Broader upstream batch (`aaf8317c8..origin/dev`) remains available for next rounds under the same analyze-and-port workflow.
