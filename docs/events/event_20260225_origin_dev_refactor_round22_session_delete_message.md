# Event: origin/dev refactor round22 (session message delete endpoint)

Date: 2026-02-25
Status: Done

## Round goal

Port high-value session API behavior to support deleting a specific message by id.

## Candidate & assessment

- Candidate: `79b5ce58e9d3ad940330c2fd82784a4d8b7e004d`
- Decision: **Port**
- Rationale:
  - User-visible API capability with low-to-medium implementation risk.
  - Aligns with existing session/message CRUD boundaries in `server/routes/session.ts`.
  - Fits current cms architecture (no direct upstream merge required).

## Rewrite-only port in cms

- `packages/opencode/src/server/routes/session.ts`
  - Added `DELETE /session/:sessionID/message/:messageID`
  - Applies `SessionPrompt.assertNotBusy(sessionID)` guard before deletion.
  - Calls `Session.removeMessage({ sessionID, messageID })` and returns `true`.

- `packages/opencode/test/server/session-message-delete.test.ts`
  - Added route-level regression test for successful message deletion.

## Validation

- `bun test packages/opencode/test/server/session-message-delete.test.ts --timeout 30000` ✅
- `bun run packages/opencode/src/index.ts --help` ✅

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before commit.
- Result: **No architecture doc update required** for this round.
  - Change is a route-level capability extension within existing Session API boundaries.
