# 2026-05-08 — codex-update execution log

Spec: [specs/codex-update/](../../specs/codex-update/)
Branch: `beta/codex-update` (off `main` `eecb3d4b3`)
State track: `proposed → designed → planned → implementing` (Phase 1 done)

## Phase 1 — session_id / thread_id header split

**Done**: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7

**Commit**: `7d05f1070` (`beta/codex-update`)

**Key decisions**:
- DD-1, DD-2 implemented as written. Default-equality (`threadId := sessionId` when omitted) keeps single-thread callers wire-compatible.
- DD-1 fallback chain extended one tail step beyond what spec.md literally said: `threadId ?? sessionId ?? conversationId(deprecated)`. Reason: the existing internal caller `transport-ws.ts:747` (and ultimately `provider.ts:206`) still references `WsTransportInput.conversationId`. Removing that surface mid-plan would ripple into provider.ts and beyond, which is out of scope; the deprecated tail of the chain absorbs it without contradicting INV-2 (threadId or sessionId always wins when set).
- Pre-existing gap discovered & fixed: the WS path's `buildHeaders` call (`transport-ws.ts:742`) was not passing `sessionId` at all, so the `session_id` header was previously never emitted on WS requests. Adding it satisfies TV-1 and INV-1; this is in scope.

**Validation**:
- `bun test packages/opencode-codex-provider/` → 113 pass / 0 fail (10 in `headers.test.ts`, includes 6 new cases: TV-1..TV-5 + back-compat)
- plan-sync: `clean` (history entry recorded)

**Drift**: none.

**Remaining**:
- Phase 2 — `prompt_cache_key` sourcing (provider.ts)
- Phase 3 — WS send-side idle timeout (transport-ws.ts)
- Phase 4 — empty-turn classifier transient extension
- Phase 5 — full provider validation
- Phase 6 — live smoke
- Phase 7 — fetch-back to test branch
- Phase 8 — promote `verified → living`
