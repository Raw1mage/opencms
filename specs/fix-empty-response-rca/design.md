# Design: fix-empty-response-rca (Phase 1: L1 + L2)

## Context

ses_204499eecffe2iUTzeXyiarlnq looped twice in 24 hours despite codex-empty-turn-recovery shipping. The post-hotfix recurrence on 2026-05-07 produced clean JSONL evidence:

- L1 manifest: `cache_read = 36352` locked across 4+ consecutive turns; `reasoning = 0` sticky; loop sustains until user-interrupted
- L2 manifest: account rotated `ivon0829 → yeatsluo` mid-session after WS truncation chain; UNKNOWN-no-promote guard at `rate-limit-judge.ts:39-52` was correctly NOT REACHED — rotation came via a different path

The L2 spike (recorded in proposal.md "Spike Findings") found the actual rotation trigger:

```
provider WS error → ws.onerror frameCount=0 → endWithError(new Error("WebSocket error"))
                  → throws upward through provider.ts.doStream
                  → caught by processor.ts:1447 catch block
                  → isModelTemporaryError(e) at processor.ts:149-181 returns true
                       (matches "WebSocket error" against server-error patterns)
                  → handleRateLimitFallback() at line 1601
                  → findFallback() at llm.ts:1552
                  → account rotation
```

Codex-empty-turn-recovery's INV-01 ("no-throw") was preserved on the SSE flush + ws.onclose+frame>0 paths, but `ws.onerror` and `ws.onclose+frame=0` still threw. Those throws are the L2 trigger.

## Goals / Non-Goals

### Goals

- Break the L1 cache equilibrium so successive turns can make progress (compaction does not produce identical bytes turn-after-turn)
- Plug the L2 throw-leak so empty-turn-class WS failures stay inside the codex provider package and surface as classifier-decided soft-fails, not as exceptions that reach `processor.ts.isModelTemporaryError`
- Preserve every codex-empty-turn-recovery invariant (INV-01, INV-04, INV-08, INV-13/14, INV-16) — this spec extends, never regresses
- Each phase ships independently and is independently rollback-able

### Non-Goals

- L3 store-flag tuning (deferred to follow-up)
- Prewarm before rotation (lower-priority once L2 throw-leak removed; defer)
- L7 cross-round observability metrics (separate spec)
- Any change to codex backend WS truncation rate (out of our control)
- Any retroactive correction of historical sessions

## Decisions

### DD-1 — Make `predictedCacheMiss` derive from observable cache state, not from sticky `continuationInvalidatedAt`

L1 culprit: [packages/opencode/src/session/prompt.ts:1884](../../packages/opencode/src/session/prompt.ts#L1884):

```ts
predictedCacheMiss: sessionExecForCompaction?.continuationInvalidatedAt ? "miss" : "unknown"
```

Once `continuationInvalidatedAt` is non-null (codex rejected `previous_response_id` once), this returns `"miss"` forever. Combined with the gate at [prompt.ts:468-471](../../packages/opencode/src/session/prompt.ts#L468-L471), cache-aware compaction triggers every turn and deterministically produces the same compressed prefix.

**Why:** `continuationInvalidatedAt` describes a past event; it does not describe current cache health. Cache may have been recovered by a successful compaction or by codex's own server-side cache mechanism. Using a past-event flag as a per-turn predicate creates the sticky behavior.

**How to apply:**

```ts
function derivePredictedCacheMiss(sessionExec, lastFinished): "miss" | "hit" | "unknown" {
  // Past invalidation alone is insufficient — check current cache evidence
  if (!sessionExec?.continuationInvalidatedAt) return "unknown"
  // Cache survived: codex returned non-zero cache.read on the most recent turn
  if (lastFinished?.tokens?.cache?.read && lastFinished.tokens.cache.read > 0) return "hit"
  // Genuine miss: still no evidence cache recovered
  return "miss"
}
```

The decision is made per-turn from the most recent observable signal. continuationInvalidatedAt stays as a historical record (don't clear it — that loses audit information), but it stops being the per-turn predicate.

### DD-2 — Route ws.onerror + ws.onclose-with-frameCount=0 + first_frame_timeout through the empty-turn classifier instead of `endWithError`

L2 culprit: three sites in [packages/opencode-codex-provider/src/transport-ws.ts](../../packages/opencode-codex-provider/src/transport-ws.ts) still throw upward:

| Site | Line | Current behavior |
|---|---|---|
| `ws.onerror` (frameCount=0) | ~472 | `endWithError(new Error("WebSocket error"))` |
| `ws.onclose` (frameCount=0) | ~495 | `endWithError(new Error("WS closed before response"))` |
| idle timer (frameCount=0) | ~289 | `controller.error(new Error("Codex WS: first_frame_timeout"))` |

Each of these throws an Error that reaches `processor.ts:1447`'s catch block, gets matched by `isModelTemporaryError()` patterns, and triggers rotation.

**Why:** codex-empty-turn-recovery's INV-01 says the provider package never throws on empty turns. These three sites violated that intent — they predate the spec and were left alone because the original "frame>0 silent endStream" was the obvious bug. The frame=0 cases also need to flow through the same classifier path.

**How to apply:**

1. Add a `wsErrorReason: string | null` field to `WsObservation` and `TransportSnapshot` in [transport-ws.ts](../../packages/opencode-codex-provider/src/transport-ws.ts) (per data-schema.json extension).
2. Replace `endWithError(new Error(...))` and `controller.error(new Error(...))` at the three sites with:
   - Set `wsObs.wsErrorReason = "<descriptive reason>"`
   - Call `endStream()` instead of `endWithError`
3. The SSE flush block at [sse.ts](../../packages/opencode-codex-provider/src/sse.ts) already classifies via `getTransportSnapshot`; with `wsFrameCount === 0`, the classifier predicate ladder selects `ws_no_frames` → `retry-once-then-soft-fail`. If retry also fails, soft-fail per INV-08.
4. Result: provider returns a normal stream that finishes with `finishReason: "unknown"` + emptyTurnClassification metadata. No exception.

### DD-3 — `isModelTemporaryError` reads `providerMetadata.openai.emptyTurnClassification` and returns false for any classified empty turn

DD-2 alone removes the throw on three known sites. But future code drift might add new throws, OR the runloop might hit other empty-turn signals via different finish reasons. Defense-in-depth: when `processor.ts:isModelTemporaryError` evaluates a caught error, it checks whether the most recent finish part had `providerMetadata.openai.emptyTurnClassification` populated. If yes, the error is not "temporary" — it's an empty turn that already had its chance to retry inside the provider, and rotation would only make things worse (cold prefix → more truncation).

**Why:** Closes the loop between the classifier (which knows this is an empty-turn case) and the rotation gate (which currently has no signal). Reads providerMetadata as opaque metadata per INV-16 — opencode runtime does NOT import codex-provider types.

**How to apply:** Add a guard at the top of `isModelTemporaryError`:

```ts
function isModelTemporaryError(e: unknown, lastFinish?: { providerMetadata?: any }): boolean {
  // codex-empty-turn-recovery integration: classified empty turns are NOT
  // temporary backend errors. The classifier already exhausted its
  // retry budget (INV-08) and emitted a soft-fail. Rotating would
  // create a cold prefix on the new account → more truncation.
  const cls = lastFinish?.providerMetadata?.openai?.emptyTurnClassification
  if (cls?.causeFamily) return false
  // ... existing pattern matching for genuine 5xx / quota / overload
}
```

The caller at processor.ts:1447 must be updated to pass the most recent assistant finish part (which it already has access to via session storage / message accumulator).

### DD-4 — Phase split

Two phases, independently shippable:

**Phase 1 (L2 throw-leak)** — DD-2 + DD-3.
- Smaller surface (codex-provider/src/transport-ws.ts + opencode/src/session/processor.ts)
- Higher confidence: the bug is structural, the fix is mechanical, immediate observable signal (no more rotation events tagged from empty-turn classification windows)
- Ships first to stop the rotation cascade

**Phase 2 (L1 cache equilibrium)** — DD-1.
- Touches compaction logic in prompt.ts; higher risk of unintended side effects on cache hit rate
- Requires careful regression testing on cache-aware compaction triggers
- Ships after Phase 1 deploys cleanly and operators see rotation rate drop

**Why this order:** Phase 1's effect is bounded (no more empty-turn-triggered rotations); Phase 2's effect is broader (compaction trigger frequency change). Land the bounded one first.

### DD-5 — Cause-family enum extension

Add new value `ws_error_no_frames` to distinguish:

- `ws_no_frames`: ws.onclose with frameCount=0 (existing — quiet close before any frame)
- `ws_error_no_frames`: ws.onerror with frameCount=0 (new — explicit error before any frame)

Or alternatively: keep `ws_no_frames` as the umbrella and use the new `wsErrorReason` field to differentiate. The latter avoids INV-13 enum churn and is preferable.

**Decision:** keep `ws_no_frames` umbrella; use `wsErrorReason` field for sub-class discrimination. INV-13 (append-only enum) is preserved without bumping schema version.

## Risks / Trade-offs

### R1 — DD-1 might reduce cache-aware compaction firing too aggressively, causing context overflow

**Impact:** if predictedCacheMiss reverts to "unknown" after one successful turn, cache-aware compaction stops firing pre-emptively, and a session might hit codex's true context-window limit unexpectedly.

**Mitigation:** the `isCacheAware()` check at prompt.ts:474 is still a backup gate. Also, the compaction policy has separate ctx-ratio thresholds. DD-1 only changes the FIRST gate; the second gate still triggers at high ctx ratios.

### R2 — DD-2 might mask genuine WS connectivity failures as classifiable empty turns

**Impact:** if codex backend is genuinely unreachable (DNS failure, mid-Atlantic cable cut), the user sees a "soft-fail empty turn" rather than a real network error. Operator visibility suffers.

**Mitigation:** the JSONL log's new `wsErrorReason` field captures the error reason verbatim. Operator queries can distinguish "WebSocket error" (probably transient) from "EAI_AGAIN" (DNS) from "ECONNREFUSED" (config). Plus the existing `console.error("[CODEX-WS] ...")` lines at sse.ts continue to log the underlying error for debugging.

### R3 — DD-3 might prevent legitimate rotations when codex backend genuinely has a sustained outage on one account

**Impact:** if account A is throwing 5xx from codex backend and our classifier (which gets the WS-class causeFamily) returns false from isModelTemporaryError, rotation never happens; user sees stuck-on-bad-account loop.

**Mitigation:** the spike confirmed that "codex backend 5xx for account A" would surface as a server_failed cause family with the actual server error message in `serverErrorMessage`. The runloop nudge fires (still broad per D-4). If sustained, operators see the cluster in the JSONL and manually intervene. This is a deliberate trade-off: don't auto-rotate on empty turns; do allow operator-initiated rotation.

### R4 — DD-2's `wsErrorReason` field addition risks data-schema.json drift

**Impact:** existing JSONL readers (operator queries M1-M7) might break if they assume a fixed shape.

**Mitigation:** new field is OPTIONAL in data-schema.json (added with `"required": false`). Existing readers ignore unknown fields. Schema version stays 1 (additive change per data-schema.json `additionalProperties: false` is the only concern — if the schema enforces no extra fields, we'd need to bump to 2; let designed-state implementation check).

### R5 — DD-3 boundary discipline (INV-16)

**Impact:** opencode runtime's processor.ts now reads providerMetadata.openai.emptyTurnClassification. If we type-import this from codex-provider, we'd violate INV-16.

**Mitigation:** Read as opaque metadata: `lastFinish?.providerMetadata?.openai?.emptyTurnClassification?.causeFamily as string | undefined`. No type import. Just structural property access. Codex-provider package boundary stays intact.

### R6 — Per the original RCA, restart-on-revision required

**Impact:** like the codex-empty-turn-recovery hotfix, these changes don't take effect until daemon restarts. Until restart, sessions continue with the old (looping) behavior.

**Mitigation:** event note explicitly states "restart required". User decision per `feedback_restart_daemon_consent.md`.

## Critical Files

- [packages/opencode/src/session/prompt.ts](../../packages/opencode/src/session/prompt.ts) — DD-1 culprit at line 1884; cache-aware compaction trigger at lines 468-471
- [packages/opencode-codex-provider/src/transport-ws.ts](../../packages/opencode-codex-provider/src/transport-ws.ts) — DD-2 throw sites at lines 289, 472, 495; WsObservation interface; TransportSnapshot
- [packages/opencode/src/session/processor.ts](../../packages/opencode/src/session/processor.ts) — DD-3 hook at lines 149-181 (`isModelTemporaryError`) + caller context at line 1447
- [packages/opencode-codex-provider/src/sse.ts](../../packages/opencode-codex-provider/src/sse.ts) — verify classifier flow remains intact after DD-2 sends new wsErrorReason field
- `packages/opencode-codex-provider/src/transport-ws.test.ts` — new regression test for DD-2 (ws.onerror frameCount=0 does not throw)
- `packages/opencode/test/session/processor-empty-turn-rotation-guard.test.ts` (NEW) — regression test for DD-3 (isModelTemporaryError returns false when emptyTurnClassification present)
- `packages/opencode/test/session/compaction-cache-equilibrium.test.ts` (NEW) — regression test for DD-1 (predictedCacheMiss returns "hit" when cache.read > 0 even with continuationInvalidatedAt set)
- `packages/opencode-codex-provider/src/empty-turn-classifier.ts` — verify ws_no_frames predicate covers the wsErrorReason cases without enum changes
- `specs/architecture.md` — extend the codex-empty-turn-recovery section with a paragraph on the throw-leak closure (DD-2) and the rotation-guard (DD-3)
- `docs/runbooks/codex-empty-turn-log-runbook.md` — add operator query for `wsErrorReason` cluster pattern (DD-5)

## Implementation order (Phase split per DD-4)

1. Phase 1 (DD-2 + DD-3 + DD-5): land throw-leak closure + rotation-guard + wsErrorReason field. Smaller, mechanical, observable signal (rotation rate drops). Verify via JSONL post-deploy.
2. Phase 2 (DD-1): land compaction predictedCacheMiss derivation change. Verify cache_read no longer locks at constant equilibrium across consecutive turns. Higher-risk; ship after Phase 1's stable.

Each phase will get its own implementation plan in tasks.md with phase-scoped acceptance checks.
