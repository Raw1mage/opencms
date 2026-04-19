# Event: web connection stale status implementation

Date: 2026-04-19
Status: Implemented in beta worktree

## Requirement

- Implement the validated weak-network stale-status fix plan in beta worktree only.
- Preserve fail-fast authority semantics; do not let stale UI continue to imply authoritative runtime state.

## Scope

### IN

- `packages/app/src/context/global-sdk.tsx`
- `packages/app/src/pages/layout.tsx`
- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/use-status-monitor.ts`
- `packages/app/src/pages/session/monitor-helper.ts`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/tool-page.tsx`

### OUT

- No main-worktree code changes
- No fetch-back / finalize / merge
- No fetch-back / finalize / merge from beta surface

## Key Decisions

- Expanded frontend connection status to explicit degraded/resyncing/blocked semantics rather than only disconnected/reconnecting.
- Chose conservative stale handling: when connection authority is uncertain, clear/hide stale active-child footer instead of guessing recovery.
- Reframed process-card elapsed display away from implying true runtime duration; treat it as freshness/update-age semantics.
- Block prompt input while connection authority is degraded/reconnecting, while preserving safe working/stop behavior.

## Changes

- `packages/app/src/context/global-sdk.tsx`
  - Added explicit connection-state expansion and transport-state transitions.
- `packages/app/src/pages/layout.tsx`
  - Added persistent operator toast for reconnecting/degraded/blocked states.
- `packages/app/src/components/prompt-input.tsx`
  - Blocked prompt input outside authoritative connected state and forced status revalidation on recovery.
- `packages/app/src/pages/session.tsx`
  - Clear/hide stale active-child footer when authority is uncertain.
- `packages/app/src/pages/session/use-status-monitor.ts`
  - Trigger refresh on reconnection to restore authoritative session-top state.
- `packages/app/src/pages/session/monitor-helper.ts`
  - Renamed/repurposed elapsed semantics to freshness-oriented updated-age behavior.
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/tool-page.tsx`
  - Suppress stale process-card authority and update copy to reflect freshness semantics.

## Verification

- `git diff --check -- <touched files>` ✅
- Focused validation attempts were environment-limited:
  - `bun run --filter @opencode-ai/app typecheck` -> failed because `tsgo` is unavailable in this environment
  - focused `bun test ...` -> failed because beta worktree could not resolve `@happy-dom/global-registrator`
  - direct `tsc --noEmit` -> not usable due incomplete workspace resolution in beta worktree

## Issues Found

- There is no dedicated authoritative active-child snapshot API yet. Current recovery therefore chooses safe clearing over inferred restoration.

## Architecture Sync

- Updated `specs/architecture.md` to record the frontend degraded-authority contract:
  - explicit connection states (`connected` / `reconnecting` / `degraded` / `resyncing` / `blocked`)
  - authority-sensitive UI must degrade when transport health is uncertain
  - active-child footer must clear/downgrade rather than imply stale running state
  - reconnect/reload must rehydrate authority before restoring footer/input surfaces

## Remaining

- Add an authoritative active-child snapshot API if product wants reconnect-after-clear to restore the footer instead of conservatively keeping it hidden.
- Re-run focused frontend validation once beta worktree test/typecheck dependencies are available in this environment.
