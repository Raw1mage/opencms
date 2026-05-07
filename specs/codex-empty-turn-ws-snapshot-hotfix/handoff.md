# Handoff: codex-empty-turn-ws-snapshot-hotfix

## Execution Contract

Implement the smallest patch that restores `wsFrameCount` at the WS transport to SSE classifier boundary.

## Required Reads

- `specs/codex-empty-turn-ws-snapshot-hotfix/proposal.md`
- `specs/codex-empty-turn-ws-snapshot-hotfix/design.md`
- `packages/opencode-codex-provider/src/transport-ws.ts`
- `packages/opencode-codex-provider/src/sse.ts`
- `packages/opencode-codex-provider/src/sse.test.ts`

## Stop Gates

- Stop if fixing the field mapping requires changing retry semantics.
- Stop if tests reveal the real transport API cannot be exercised without a larger refactor.
- Stop before any daemon restart; only `system-manager_restart_self` is allowed if the user explicitly asks for live deployment.

## Validation Plan

- Focused codex-provider tests covering classifier and SSE empty-turn path.
- Add one regression test for the real boundary contract.
- Inspect resulting test log payload for numeric `wsFrameCount`.

## Backup

XDG whitelist backup created before implementation: `/home/pkcs12/.config/opencode.bak-20260507-1200-codex-empty-turn-ws-snapshot-hotfix/`.

This is a pre-plan snapshot for manual restore only; do not restore unless explicitly requested.
