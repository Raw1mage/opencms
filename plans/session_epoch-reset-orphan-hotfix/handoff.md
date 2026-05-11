# Handoff: session_epoch-reset-orphan-hotfix

## Execution Contract

This is a **hotfix**, not a refactor. Two additive patches:

1. `persistUserMessage` reclaims orphan assistant rows on user-msg arrival (age ≥ 5000ms).
2. `RebindEpoch.bumpEpoch` emits a `session.rebind_epoch_unexpected_reset` anomaly when a `daemon_start` bump sees `previousEpoch=0` for a sessionID already bumped in this process.

No existing behaviour changes on the happy path. Implementation MUST stay confined to the two files listed under "Critical Files" in design.md plus the two new test files; any cross-cutting refactor is out of scope and should split into a separate spec.

Code lands on a beta worktree per `beta-workflow` skill; main repo only receives the fetch-back after verification. Daemon restart only after user consent.

## Required Reads

Before writing the patch, the implementer MUST read:

- `packages/opencode/src/session/user-message-persist.ts` (entire file — only 43 lines)
- `packages/opencode/src/session/rebind-epoch.ts` (entire file — 230 lines)
- `packages/opencode/src/session/index.ts` lines 821-848 (Session.messages accessor) and 1000-1017 (Session.updateMessage)
- `packages/opencode/src/system/runtime-event-service.ts` lines 1-50 (event schema, append signature)
- `packages/opencode/src/session/message-v2.ts` lines 648-697 (Assistant schema; `finish`, `time.completed`, `error` fields)
- This package's `spec.md` Requirements section and `design.md` DD-1 through DD-7

## Stop Gates In Force

- AGENTS.md §1 no-silent-fallback — every reclaim and every unexpected reset MUST emit a structured event.
- Memory rule "Restart Daemon Requires User Consent" — DO NOT auto-restart the daemon after patch; ask the user.
- Memory rule "Commit All Means Split Code From Docs" — code commit (in beta worktree) and plan-doc commit (in main repo) MUST be separate.
- Memory rule "Always Commit Submodule Pointer Bumps" — none expected here; flag if any submodule changes.
- Memory rule beta-workflow §7.1 — fetch-back happens in `~/projects/opencode`, not a worktree.

## Execution-Ready Checklist

- [ ] Beta worktree branch created (suggested: `beta/session-epoch-reset-orphan-hotfix`)
- [ ] M1-1 through M1-4 (orphan reclaim) implemented
- [ ] M2-1 through M2-5 (rebind reset anomaly) implemented
- [ ] M3-1 through M3-4 (unit tests) all pass
- [ ] `bun run typecheck` (or repo equivalent) green
- [ ] M4 validation evidence captured in events/
- [ ] User asked before daemon restart
- [ ] Plan-doc commit on main; code commit on beta branch; both messages reference this slug
