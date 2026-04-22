# Event: frontend-session-lazyload revise — Phase R1 (SSE bounded replay)

**Date**: 2026-04-22
**Spec**: `specs/frontend-session-lazyload/` (state=designed, mode=revise)
**Beta branch**: `beta/frontend-session-lazyload-revise` @ `d674b120e`
**Trigger**: 2026-04-22 production RCA — gateway received 7× `POST /prompt_async` for `ses_24b2d916dffeaKQcN79znevt1b` during 19:31–19:35, daemon structured log recorded 0× `prompt_async inbound`. Diagnosis: splice proxy reverse-pressure from daemon event-loop starvation, triggered by SSE reconnect handshake serialising 1000 ring-buffer events through `await stream.writeSSE`.

## Phase

R1 — SSE reconnect bounded replay (Requirement R8, Decision DD-13, Invariant INV-8).

## Done

- **R1.1** `_sseBuffer` entries carry `receivedAt`; `ssePush` stamps `Date.now()`
- **R1.2** Pure helpers `clipReplayWindow` + `sseGetBoundedSince` + `buildHandshakeReplayPlan` extracted from handshake and unit-testable without Instance
- **R1.3** Handshake rewritten: consumes `sseGetBoundedSince(lastId, maxEvents, maxAgeMs, now)` and `buildHandshakeReplayPlan`; prefixes `sync.required` when drops occur; buffer-overflow (`events === null`) handled as before
- **R1.4** Tweaks: new `SseReplayConfig` namespace (`maxEvents=100`, `maxAgeSec=60`); parse + fallback + `Tweaks.sseReplay()` accessor; `templates/system/tweaks.cfg` documents both keys
- **R1.5** Telemetry: `[SSE-REPLAY] lastId=X returned=N dropped=M boundary={count|age|none}` once per handshake
- **R1.6** Tests (`packages/opencode/test/server/sse-bounded-replay.test.ts`) — 13 tests, 535 `expect()` calls, all pass; includes TV-R8-S1..S5 + property-like assertion that `buildHandshakeReplayPlan` respects `≤ maxEvents+1` writeSSE bound across 500 randomised buffer shapes (INV-8)

## Key Decisions (new)

- **DD-13** bounded handshake replay (see `design.md`)
- **INV-8** handshake writeSSE count ≤ `max_events + 1`, proven by `buildHandshakeReplayPlan` decomposition + tests
- Split into **pure** (`clipReplayWindow`) vs **stateful** (`sseGetBoundedSince`) vs **decision** (`buildHandshakeReplayPlan`) so the critical invariant is verifiable without HTTP plumbing

## Validation

- `bun test packages/opencode/test/server/sse-bounded-replay.test.ts` — 13/13 pass (735 ms)
- `bun test packages/opencode/test/config/tweaks.test.ts` — 25/25 pass, no regression from tweaks namespace addition
- `bun tsc --noEmit -p packages/opencode/tsconfig.json` — no new errors in touched files
- Production repro expected when R1 + R2 both land: gateway journal shows `POST /prompt_async` → daemon structured log records `prompt_async inbound` 1:1

## Drift

- None detected
- `plan-sync` deferred until R2 lands (both phases share the spec package and belong to one revise cycle)

## Remaining before state `verified`

- R2 (session.messages cursor pagination) — blocks promotion
- Phase 1–6 (original spec scope still planned; revise order puts R1+R2 first)
- Phase 5 rollout (tweaks flag default, load test, architecture.md sync)

## Traceability

- spec: Requirement R8, Scenarios R8.S1–S5
- design: Decisions DD-13, Risks R-8
- data-schema: `SseReplayHandshakeResult`, `SseReplayConfig` tweaks keys
- test-vectors: TV-R8-S1..S5 mirrored in unit test assertions
- invariants: INV-8
