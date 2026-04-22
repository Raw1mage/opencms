# Event: frontend-session-lazyload revise — Phase R2 (messages cursor pagination)

**Date**: 2026-04-22
**Spec**: `specs/frontend-session-lazyload/` (state=designed, mode=revise)
**Beta branch**: `beta/frontend-session-lazyload-revise` @ `4d0151e34`
**Predecessor**: R1 event (`event_20260422_frontend-session-lazyload-revise-R1.md`)

## Phase

R2 — session.messages cursor pagination (Requirement R9, Decision DD-14, Invariants INV-9 + INV-10).

## Done

- **R2.1** `GET /:sessionID/message` accepts `beforeMessageID`; tail-first default (`session_messages_default_tail`, default 30) when no cursor and no explicit limit
- **R2.2** SessionCache key renamed to `messages:{id}:tail:{limit}` for cold-open tail; cursor path bypasses ETag/304 (slice, not full-snapshot)
- **R2.3** `UserDaemonManager.callSessionMessages` signature extended to accept `{limit, since, beforeMessageID}` opts object; all three passed through via URLSearchParams — INV-10 satisfied
- **R2.4** Frontend `history.loadMore` rewritten: reads oldest known `messageID`, fetches via direct `sdk.fetch` with `beforeMessageID=<oldest>&limit=N`, appends (dedup by id, re-sort by id-prefix) into store. No more `currentLimit + count` refetch.
- **R2.5** `history.complete` driven by server returning `appended < count` (which covers empty-page and short-page cases). Old arithmetic deleted.
- **R2.6** tweaks: `sessionMessagesDefaultTail` field added to `FrontendLazyloadConfig`; `session_messages_default_tail` key + range validation in `tweaks.ts`; `templates/system/tweaks.cfg` documents the key.
- **R2.7** Telemetry: `[MESSAGES-CURSOR] sessionID=X before={id|null} limit=N returned=M` once per fetch — verified by test suite output.
- **R2.8** `Session.messages` also accepts `beforeMessageID`; stream skips newest-first until cursor then drops it (strictly-older semantics).

## Key Decisions

- **DD-14** tail-first default, cursor append (see `design.md`)
- **INV-9** `/:id/message` no cursor = tail N, not full dump; frontend never uses `currentLimit+count` refetch
- **INV-10** CMS→daemon proxy must pass through `limit` + `since` + `beforeMessageID` — structural guarantee via opts object + single `URLSearchParams` construction point
- Client uses direct `sdk.fetch` for the cursor call (mirrors `loadMessagesIncremental`). Avoids SDK regeneration blocker; OpenAPI schema already declares the param via the zod validator.

## Validation

- `bun test packages/opencode/test/server/session-messages-cursor.test.ts` — 5/5 pass (4.85s)
  - TV-R9-S1 (tail default 30)
  - TV-R9-S2 (cursor returns strictly-older 10)
  - TV-R9-S3 (cursor at earliest → empty)
  - TV-R9-S5 (legacy limit-only = tail limit)
  - cap-limit invariant (limit=15, cursor far back → exactly 15 returned)
  - `[MESSAGES-CURSOR]` telemetry visible in test stdout
- `bun test packages/opencode/test/server/sse-bounded-replay.test.ts` — 13/13 still pass
- `bun test packages/opencode/test/config/tweaks.test.ts` — 25/25 still pass, no regression from new key
- `bun test packages/opencode/test/server/session-meta.test.ts` — 5/5 still pass (cache-key rename didn't affect meta)
- `bun tsc --noEmit -p packages/opencode/tsconfig.json` — no new errors in touched files
- `bun tsc --noEmit -p packages/app/tsconfig.json` — no new errors in `sync.tsx` (only one pre-existing error at line 322, unrelated)

## Drift

- None detected.
- CMS proxy transitive test deferred to real-daemon integration (added to verification checklist in `handoff.md` G-10).

## Remaining before state `verified`

- Run R1+R2 together in beta runtime (webctl dev-start in opencode-beta, reproduce 2026-04-22 symptom on long session).
- Confirm daemon structured log records `prompt_async inbound` 1:1 with gateway `POST /prompt_async` during a streaming turn.
- Fetch-back to `test/frontend-session-lazyload-revise` on main repo, validate, then finalize to `main`.
- Phase 1–6 of original spec still `planned` (per DD-15 they come after R1+R2).
- Phase 5 rollout (tweaks flag defaults, load test, `specs/architecture.md` sync).

## Traceability

- spec: Requirement R9, Scenarios R9.S1–S6
- design: Decisions DD-14, DD-15, Risks R-9, R-10
- data-schema: `SessionMessagesQuery`, `session_messages_default_tail` tweak
- test-vectors: TV-R9-S1..S6 mapped 1:1 to unit tests
- invariants: INV-9, INV-10
- handoff: Stop gates G-9, G-10
