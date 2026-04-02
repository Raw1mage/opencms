# Event: Gmail MCP Background Token Refresh

**Date**: 2026-04-02
**Plan**: `plans/20260401_1/`

## Requirements

- Gmail auth currently relies on a shared Google OAuth token file and only refreshes on demand.
- Add a shared background refresh mechanism so Gmail/Calendar tokens are proactively renewed before expiry.
- Keep on-demand refresh as a safety net and preserve the shared `gauth.json` authority.

## Scope

### IN

- Shared background refresh design for `gauth.json`
- Gmail + Calendar token freshness maintenance
- Plan artifact alignment for the proactive refresh workstream

### OUT

- OAuth consent flow changes
- Separate token storage or per-app refresh files
- Any fallback mechanism that hides auth failures

## Task List

- [x] Locate the current Gmail/Calendar token refresh path
- [x] Confirm the shared token storage and on-demand refresh behavior
- [x] Refine the active plan artifacts for the background refresh workstream
- [x] Implement the background refresh controller
- [x] Add/adjust verification for proactive refresh and persistence

## Conversation Summary

- Subagent evidence confirmed `packages/opencode/src/mcp/apps/gauth.ts` already does on-demand refresh and persists refreshed tokens.
- Gmail tools call the shared helper on every invocation, so the missing piece is proactive background refresh.
- Shared Google token ownership remains the right boundary because Gmail and Calendar both read `gauth.json`.
- User clarified the desired lifecycle: run a silent background sweep on every daemon startup because lazy loading plus frequent daemon restarts may never touch Gmail/Calendar during a session.
- The refresh path also needs serialized access to avoid concurrent background + on-demand refresh races.

## Debug Checkpoints

### Baseline

- Symptom: Gmail auth can be expired by the time a tool call starts.
- Existing behavior: refresh happens only when a tool call resolves its token.

### Instrumentation Plan

- Check the shared Google token helper for refresh timing and persistence.
- Check the managed-app registry / MCP lifecycle for a safe place to start a background refresh controller.

### Execution

- Confirmed the helper already refreshes on-demand and writes updated tokens back to `gauth.json`.
- Confirmed there is no proactive background refresh loop yet.
- Confirmed managed-app state is currently derived from `gauth.json`, so refresh success needs an explicit publish/update path to become observable immediately.
- Implemented serialized shared Google refresh coordination in beta worktree and added a reusable one-shot sweep entrypoint in `packages/opencode/src/mcp/apps/gauth.ts`.
- Wired one-shot daemon-start sweep into MCP lazy init via `packages/opencode/src/mcp/index.ts`.
- Added focused tests for serialized refresh, refresh-triggered observability publish, and MCP startup sweep behavior.
- Tightened the startup policy so the daemon-start Google sweep only runs when at least one Google managed app is actually installed and enabled, instead of keeping stale shared auth alive for unused apps.
- Tightened the observability publish path so refresh success only notifies active Google apps rather than broadcasting synthetic updates to both Gmail and Calendar.

### Root Cause

- The refresh primitive exists, but only tool invocation triggers it; daemon startup currently performs no Google token sweep.

### Validation

- Architecture sync completed after implementation: `specs/architecture.md` now reflects the daemon-start sweep and serialized refresh contract.

## Validation

- Plan artifacts updated to reflect the shared Google refresh direction.
- Architecture sync reviewed: no new module boundary was introduced, but daemon-start sweep behavior should be reflected in the managed-app/runtime notes before implementation is considered complete.
- Architecture sync completed: `specs/architecture.md` already reflects the daemon-start sweep + serialized refresh contract, and the implemented files match that description.
- Beta admission verified with explicit authority separation:
  - `mainRepo` / `mainWorktree` / `baseBranch`: `/home/pkcs12/projects/opencode` / `/home/pkcs12/projects/opencode` / `main`
  - `implementationRepo` / `implementationWorktree` / `implementationBranch`: `/home/pkcs12/projects/opencode` / `/home/pkcs12/projects/opencode-worktrees/google-mcp-refresh-daemon-sweep` / `beta/google-mcp-refresh-daemon-sweep`
  - `docsWriteRepo`: `/home/pkcs12/projects/opencode`
- Beta worktree was created from authoritative `main` HEAD and verified as a separate disposable execution surface.
- Focused validation passed:
  - `bun test "/home/pkcs12/projects/opencode-worktrees/google-mcp-refresh-daemon-sweep/packages/opencode/src/mcp/apps/gauth.test.ts" "/home/pkcs12/projects/opencode-worktrees/google-mcp-refresh-daemon-sweep/packages/opencode/src/mcp/index.startup-sweep.test.ts" "/home/pkcs12/projects/opencode-worktrees/google-mcp-refresh-daemon-sweep/packages/opencode/src/mcp/index.startup-sweep.inactive.test.ts"`
  - Result: 6 pass / 0 fail
- Requirement coverage verified:
- daemon-start one-shot sweep: implemented in `packages/opencode/src/mcp/index.ts`
- daemon-start sweep gating: now runs only when at least one Google managed app is installed and enabled
- serialized refresh coordination: implemented in `packages/opencode/src/mcp/apps/gauth.ts`
- observability publish after successful refresh: implemented via `packages/opencode/src/mcp/apps/gauth.ts` + `packages/opencode/src/mcp/app-registry.ts`, scoped to active Google apps only
- on-demand refresh preserved: verified in the shared helper path and focused tests
- Validation environment note: beta worktree temporarily used dependency parity with the authoritative repo so focused tests could resolve dependencies; this was verification-only, not product behavior.
- Bounded typecheck note: repo-wide `tsc` remains noisy because of unrelated pre-existing `infra/*` errors, but touched files no longer appear in the typecheck error set after fixing `packages/opencode/src/mcp/apps/gauth.test.ts` mock typing.

## Remaining

- Keep beta cleanup pending until the user asks to finalize/merge the beta workflow.
