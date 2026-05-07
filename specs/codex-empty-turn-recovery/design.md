# Design: codex-empty-turn-recovery

## Context

The empty-turn symptom in the codex provider has at least five identified upstream causes (see `proposal.md` External References table) plus an `unclassified` residue. The current implementation collapses all of them into a single `finishReason: "unknown"` + zero-token finish, which the runloop's `?` nudge then handles as if it were a model-emitted empty stop. This design specifies how to split that single failure path into a classified, evidence-preserving, non-blocking pipeline.

The design respects the proposal-level decisions D-1 through D-5 (max fault tolerance, log evidence floor, audit-before-omit, broad nudge, slug locked) and translates them into concrete code-level decisions (DD-prefixed below).

## Goals / Non-Goals

### Goals

- Every empty turn produces a classification + a forensic log entry, regardless of cause
- Recovery is always non-blocking; CMS continues
- Implementation is contained inside `packages/opencode-codex-provider/`; runloop changes are minimal (metadata pass-through only)
- Future causes can be added by appending to the cause-family enum (open for extension; closed for breaking changes)

### Non-Goals

- Reducing the rate of empty turns (the upstream causes are largely server-side; we only handle them)
- Replacing the runloop nudge (D-4 keeps it broad)
- Building an admin UI for log inspection (out of scope; logs are JSONL on disk + optional bus for future consumers)

## Decisions

### DD-1 — Classifier lives in a new module: `empty-turn-classifier.ts`

The classifier is a pure function: `(streamStateSnapshot, requestOptionsShape) → { causeFamily, recoveryAction, suspectParams[] }`. It does no I/O. It is unit-testable in isolation. Locating it inside `sse.ts` would entangle stream parsing with classification logic and make testing harder.

**Why:** Pure-function discipline + separate file makes the classifier the single point of truth for cause-family decisions. Future causes can be added by extending one switch statement in one file.

**How to apply:** New file `packages/opencode-codex-provider/src/empty-turn-classifier.ts` exports `classifyEmptyTurn()`. Both `sse.ts` flush and `transport-ws.ts` ws.onclose call it.

### DD-2 — Log destination: JSONL file at `Global.Path.state/codex/empty-turns.jsonl`, mirrored to bus event `codex.emptyTurn`

The JSONL file is the **load-bearing** evidence path (durable, grep-able, survives process restarts). The bus event is a non-load-bearing convenience for live consumers (future admin-panel surface, future telemetry shipper).

**Why:** D-2 mandates evidence preservation as the floor. Bus alone is volatile (no consumer attached → evidence lost). JSONL alone leaves real-time consumers blind. Both gives durability with optional reactivity.

**How to apply:** `empty-turn-log.ts` writes one JSON object per line to `<state>/codex/empty-turns.jsonl` via append-only file handle; on success, also publishes to `Bus` channel `codex.emptyTurn` with the same payload. Failure to publish to bus is silent. Failure to write to file emits the `console.error` fallback per spec.md `Forensic evidence preservation` § Scenario 3.

### DD-3 — Log rotation: size-triggered by external rotation (logrotate), not in-process

The codex provider does not rotate the JSONL file. An external systemd/cron job (or operator decision) handles rotation under existing log management policy. The provider only appends.

**Why:** In-process rotation introduces locking + concurrency complexity that's outside the spec's scope. Following the same pattern as opencode's other line-oriented logs.

**How to apply:** Document the path in `architecture.md` so operators know to add it to logrotate. No code in this spec touches rotation.

### DD-4 — Classifier invocation site in `sse.ts`: at the start of the flush block, before finishReason fallback

The flush block in `sse.ts:142-184` currently runs three steps: (a) flush dangling tool args, (b) compute fallback finishReason, (c) emit `finish` part. The classifier inserts a step (a.5) between (a) and (b): if the turn is "effectively empty" (no text-delta or tool-call was emitted to controller during the stream), invoke the classifier; classifier's recovery action drives the finishReason in step (b) and adds providerMetadata in step (c).

**Why:** Inserting at the flush boundary keeps the classifier outside the per-event hot path. The flush block already centralizes terminal-state decisions, so adding classification there is the smallest natural change.

**How to apply:** Track `state.emittedTextDeltas: number` and `state.emittedToolCalls: Set<string>` (latter already exists; former is new counter). In flush, if both are zero, invoke classifier. Classifier returns `{causeFamily, recoveryAction, suspectParams}`. Emit log via `empty-turn-log.ts`. Use `recoveryAction` to pick `finishReason` (mapping in DD-9). Attach classification to `finish.providerMetadata.openai.emptyTurnClassification`.

### DD-5 — Classifier invocation site in `transport-ws.ts`: replacing the silent `endStream()` at line 422

The current code at `transport-ws.ts:418-424` calls `endStream()` silently when WS closes mid-stream with `frameCount > 0`. This is the proximate violation of `feedback_no_silent_fallback.md`. The new code calls into the classifier with the WS-layer state (frameCount, terminalEventReceived flag, ws close code/reason if available), then either:

- For `retry-once-then-soft-fail`: signal a one-shot retry (DD-7); if retry also fails, fall through to graceful endStream() with classification metadata flowing into the SSE flush block.
- For other actions: graceful endStream() with classification metadata.

**Why:** The WS layer has unique observable state (frameCount, ws close code) that the SSE layer can't see post-hoc. Doing classification at the WS layer captures this state at the right moment.

**How to apply:** Augment `state` object in `transport-ws.ts` with `terminalEventReceived: boolean` (set true when one of the four terminal SSE event types is parsed). On ws.onclose, pass state to classifier. Classifier returns recovery action; if `retry-once-then-soft-fail`, dispatch retry per DD-7.

### DD-6 — Recovery dispatch: a switch statement in the call site, not a strategy class

Each call site (sse.ts flush, transport-ws.ts onclose) handles the recovery action via a local switch on the four enum values. No strategy class, no dispatcher object.

**Why:** Four enum values, two call sites. A strategy class is over-engineered for this scale. `feedback_minimal_fix_then_stop.md`: smallest working shape first.

**How to apply:** Local switch in each site. If a future revision adds a fifth recovery action that needs cross-site coordination, that revision's design.md will introduce a dispatcher.

### DD-7 — Retry implementation: at the transport layer (re-open WS), not at the provider layer

`retry-once-then-soft-fail` re-opens the WS connection for the same response.create body once. If the second attempt also lands as empty, the second classification proceeds with `pass-through-to-runloop-nudge` (no third retry, no exception). Retry happens transparently to the SSE layer — the SSE pipeline sees only the second attempt's frames.

**Why:** Re-opening at WS layer reuses the same request body / continuation state. Retrying at provider layer would require the provider to re-enter doStream, which interacts with AI SDK's stream lifecycle in undefined ways.

**How to apply:** In `transport-ws.ts`, factor the WS-open + frame-loop logic into a function callable twice. `state.retryCount` tracks attempts; max 1. If both attempts produce empty turns, the second's flush takes the soft-fail path.

**Risk:** Retry doubles request load against a degraded backend (Risk R3). Mitigation: hard cap at one retry; classifier MUST NOT loop into more retries even if the second attempt is also `ws_truncation`-classified.

### DD-8 — `synthesize-from-deltas` is implemented as a defensive option but is dormant in our code path

We are delta-driven (verified against hermes #5736), so `synthesize-from-deltas` will never be selected by current cause-family logic. It's in the action vocabulary because: (a) it future-proofs the spec if upstream codex ever changes shape, (b) it's a legitimate non-blocking action, (c) implementing it now (as a no-op for our case) costs nothing and lets us validate the dispatcher's enum coverage in tests.

**Why:** Cheap insurance. Removing it later is easier than adding it later when something breaks.

**How to apply:** Implement the action (assemble accumulated text-delta payloads into a single text part) but the cause-family logic MUST NOT select it for any current scenario. Test coverage asserts the action exists and works on a synthetic scenario, but production never selects it.

### DD-9 — Cause-family enum and finish-reason mapping

| Cause family | Selected when | Recovery action | finishReason emitted |
|---|---|---|---|
| `ws_truncation` | `frameCount > 0` AND no terminal event AND ws.onclose | `retry-once-then-soft-fail` | `unknown` after retry exhausted |
| `ws_no_frames` | `frameCount === 0` AND ws.onclose/onerror | `retry-once-then-soft-fail` | `unknown` after retry exhausted |
| `server_empty_output_with_reasoning` | `response.completed` arrived AND zero deltas AND request body had `reasoning.effort` or `include` | `pass-through-to-runloop-nudge` | `other` |
| `server_incomplete` | `response.incomplete` arrived AND zero deltas | `pass-through-to-runloop-nudge` | `length` if `incomplete_details.reason === "max_output_tokens"`, else `other` |
| `server_failed` | `response.failed` or top-level `error` AND zero deltas | `pass-through-to-runloop-nudge` | `error` |
| `unclassified` | empty turn AND none of the above | `pass-through-to-runloop-nudge` | `unknown` |

**Why:** Each finish-reason maps to the closest AI SDK enum value while staying within the standard set. `unknown` for retry-exhausted and unclassified preserves the existing runloop nudge trigger condition (D-4: nudge stays broad).

**How to apply:** This table is the single source of truth. Code constants in `empty-turn-classifier.ts` MUST mirror it; data-schema.json's `causeFamily` enum MUST mirror it.

### DD-10 — Recovery action enum

```
retry-once-then-soft-fail
synthesize-from-deltas
pass-through-to-runloop-nudge
log-and-continue
```

Note: `log-and-continue` is the action when the empty-turn detection itself fires but no recovery beyond logging is appropriate (e.g., a future cause-family entry where the runloop nudge would be wrong). It's reserved for future causes; no current cause-family selects it.

`hard-error` is excluded (D-1).

### DD-11 — providerMetadata structure on the `finish` part

```ts
finish.providerMetadata = {
  openai: {
    responseId: <string>,                         // existing field
    emptyTurnClassification: {
      causeFamily: <enum>,
      recoveryAction: <enum>,
      suspectParams: <string[]>,                  // e.g., ["reasoning.effort"]
      logSequence: <number>,                      // monotonic counter for cross-referencing log entry
      retryAttempted: <boolean>,
      retryAlsoEmpty: <boolean | undefined>,
    }
  }
}
```

The `logSequence` lets the runloop's nudge handler include a back-pointer to the JSONL log entry, enabling forensic correlation without joining on session+message+timestamp.

### DD-12 — Implementation order: logging first, classification second, retry third

Phase 1 ships: log infrastructure (`empty-turn-log.ts`, JSONL writer, bus emitter) + empty-turn detection in flush block (binary: empty or not) + skeleton classifier returning `unclassified` for everything. This alone gives us the production data needed for D-3's audit-before-omit.

Phase 2 ships: real cause-family discrimination per DD-9 (without retry yet).

Phase 3 ships: retry implementation per DD-7.

Each phase is independently shippable. Phase 1 is the load-bearing one (D-2 evidence floor); phases 2 and 3 are refinements.

**Why:** Smallest working shape first. Production data drives which causes are real before tuning the classifier.

## Risks / Trade-offs

### R1 — Log volume in production
**Impact:** disk usage growth on long-running CMS instances.
**Mitigation:** DD-3 documents the JSONL path so logrotate can be wired in by operators. Each entry is small (≤ 2 KB JSON line). Worst case at 1 empty-turn-per-minute average is ~3 GB/year per instance — manageable, bounded.

### R2 — Classifier false positives
**Impact:** A real-but-truncated response (where some text was streamed but the user still saw it as broken) could be tagged as `ws_truncation` and retried, producing duplicate output.
**Mitigation:** Classifier predicate for `ws_truncation` MUST require `state.emittedTextDeltas === 0 && state.emittedToolCalls.size === 0` — i.e., a turn with ANY emitted content is never empty-classified, never retried.

### R3 — Retry doubles load on degraded backend
**Impact:** When codex is broadly degraded, retries amplify the bad-traffic pattern.
**Mitigation:** DD-7 caps retry at 1. No exponential backoff, no second retry. After one retry, soft-fail and let the runloop nudge handle escalation.

### R4 — Synthesize-from-deltas is dormant
**Impact:** Code path that's never exercised in production rots silently.
**Mitigation:** DD-8 mandates a unit test for the synthesize action. CI runs the test on every change; if the action breaks, CI fails before any future cause-family revision tries to select it.

### R5 — Schema drift between code enum and data-schema.json
**Impact:** Log entries fail validation; downstream consumers break.
**Mitigation:** A unit test asserts that the `causeFamily` enum values in `empty-turn-classifier.ts` exactly match the `enum` array in `data-schema.json`. CI catches drift on the same change.

### R6 — Account rotation amplifies cause E (ws_truncation) probability
**Impact:** Each new account joining mid-session sends a cold-cache 222K-token prefix, which has higher truncation probability than warm-cache turns.
**Mitigation:** Out of scope for this spec (tracked in proposal Risks). Logging the per-turn `accountId` lets us correlate retry rate with rotation patterns and decide later whether the account-rotation policy needs revision.

### R7 — Spec's `audit-then-act` for OpenHands B/C may take long
**Impact:** Real B/C cause exposure stays unfixed in production while we collect data.
**Mitigation:** Spec's Acceptance Check A6 requires a 24-hour smoke test with the classifier before promoting to verified. Even if B/C exposure is suspected, ship classifier + logs first; B/C parameter omission is an `extend` mode revision per D-3 / spec Requirement `Audit-before-omit`.

## Critical Files

- [packages/opencode-codex-provider/src/sse.ts](../../packages/opencode-codex-provider/src/sse.ts) — flush block invocation (DD-4); add `emittedTextDeltas` counter; emit classification in `finish.providerMetadata`
- [packages/opencode-codex-provider/src/transport-ws.ts](../../packages/opencode-codex-provider/src/transport-ws.ts) — replace silent `endStream()` at line 422 with classifier call (DD-5); implement retry per DD-7
- [packages/opencode-codex-provider/src/provider.ts](../../packages/opencode-codex-provider/src/provider.ts) — Phase 1 also: builds sanitized `requestOptionsShape` from request body, threads `logContext` + `getTransportSnapshot` into `mapResponseStream` for both WS and HTTP paths
- [packages/opencode/src/plugin/codex-auth.ts](../../packages/opencode/src/plugin/codex-auth.ts) — opencode runtime injection point; calls `setEmptyTurnLogPath(<Global.Path.state>/codex/empty-turns.jsonl)` and `setEmptyTurnLogBus(...)` at provider initialization (mirrors the existing `setContinuationFilePath` pattern; preserves provider boundary INV-16 by keeping Global.Path / Bus imports out of the codex-provider package)
- `packages/opencode-codex-provider/src/empty-turn-classifier.ts` — **new** — pure-function classifier (DD-1, DD-9, DD-10)
- `packages/opencode-codex-provider/src/empty-turn-log.ts` — **new** — JSONL writer + bus emitter (DD-2, DD-3)
- `packages/opencode-codex-provider/src/empty-turn-classifier.test.ts` — **new** — unit tests for every cause-family scenario from spec.md
- `packages/opencode-codex-provider/src/empty-turn-log.test.ts` — **new** — unit tests for log emission + log-failure-doesn't-block-recovery
- [specs/architecture.md](../architecture.md) — append paragraph on empty-turn classifier path + JSONL log location (DD-3)
