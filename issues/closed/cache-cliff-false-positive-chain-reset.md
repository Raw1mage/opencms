# Bug Report — Cache-Cliff False Positive May Self-Induce Chain Reset

Date: 2026-05-24
Status: Resolved (closed 2026-05-29; b58867e69)
Severity: high
Area: Codex WS continuation / cache-cliff detection / context budget telemetry

## Summary

Cache-cliff detection may be triggering on healthy Codex cache states and then clearing `previous_response_id` via `invalidateContinuationFamily`. That forces the next Codex WS request out of delta mode into a full-input resend. Under Codex server cache/chain pressure, this blunt reset may itself create the cache cliff it was meant to recover from.

## User-Reported Signal

The user observed multiple `<context_budget>` envelopes where local uncached input is tiny, context status is green, and cache hit rate remains very high:

```text
window: 272000
used: 5039
ratio: 0.02
status: green
cache_read: 76800
cache_hit_rate: 0.94
```

Earlier observations in the same investigation showed similarly healthy cache signals:

```text
used: 1695
ratio: 0.01
cache_read: 57344
cache_hit_rate: 0.97
```

```text
used: 2433
ratio: 0.01
cache_read: 54272
cache_hit_rate: 0.96
```

These do not look like model amnesia or near-empty context. They look like a small delta tail plus a healthy cached prefix.

## Current Behavior

`deriveObservedCondition` tracks only previous and current `cache_read`:

- If previous `cache_read > 50_000`
- And current `cache_read < previous * 0.5`
- Then it records `cache_cliff_detected`
- Calls `invalidateContinuationFamily(sessionID)`
- Returns `null`, so no compaction runs

This clears the Codex continuation chain. The next WS request omits `previous_response_id`, so `transport-ws.ts` sends the full input array instead of a delta slice.

## Suspected Root Cause

The cache-cliff predicate is under-specified. It assumes a large relative cache-read drop means the server silently lost the chain, but it does not verify whether the current state is actually unhealthy.

Missing guards:

- Current `cache_read` may still be large and healthy, e.g. 54K–76K.
- `cache_hit_rate` may still be very high, e.g. 0.94–0.97.
- Local `used` may be only the uncached delta tail, not total effective context.
- Prompt/input may have naturally shrunk after tool boundaries, compaction, or anchor changes.
- The detector does not compare current full input size, anchor generation, compaction recency, or item count.

## Why This Can Self-Induce a Cliff

False positive path:

1. Session has healthy cached prefix and small delta tail.
2. `cache_read` drops relatively, but remains healthy in absolute terms.
3. Detector treats the drop as `cache_cliff_detected`.
4. Runtime clears `previous_response_id` for the continuation family.
5. Next request sends full input instead of delta.
6. Codex server must rebuild or rebind cache/chain under load.
7. The full resend can be slower, more expensive, and more likely to cold-start or evict.
8. The recovery mechanism becomes a cliff amplifier.

## Evidence References

- `packages/opencode/src/session/prompt.ts:460` — cache-cliff detection uses only previous/current `cache_read` ratio and absolute previous floor.
- `packages/opencode/src/session/prompt.ts:493` — detector clears continuation via `invalidateContinuationFamily` and returns without compaction.
- `packages/provider-codex/src/transport-ws.ts:342` — Codex WS delta mode depends on `previous_response_id`.
- `packages/provider-codex/src/transport-ws.ts:370` — when no `previous_response_id`, request is not delta mode and sends full input.
- `packages/opencode/src/session/prompt.ts:257` — `<context_budget>` reports `used = tokens.input` and `ratio = used / window`, while `cache_read` is separate; this can make healthy cached context appear as only 1–2% used.

## Expected Behavior

Cache-cliff recovery should only clear continuation when there is evidence of actual server-side context loss, not merely a relative cache-read drop.

Healthy states should be telemetry-only:

- current `cache_read` remains above a safe floor
- `cache_hit_rate` remains high
- effective context appears stable
- no empty/stalled/model-amnesia symptom is present

## Proposed Fix

Replace the single relative-drop predicate with a multi-signal gate:

1. Compute `effectiveInput = tokens.input + tokens.cache.read` for context-budget display and policy.
2. Treat cache cliff as actionable only when current cache is unhealthy, e.g. `currentCacheRead < systemPromptCacheFloor` or `cacheHitRate < lowHitRateFloor`.
3. Require stable prompt/anchor generation: no recent compaction, anchor rewrite, provider/account switch, or natural input shrink.
4. On first suspected cliff, record telemetry only; require a second corroborating symptom such as empty response, repeated low-cache turn, or model-amnesia/stall signal before clearing continuation.
5. Add debug payload fields: `prevCacheRead`, `currentCacheRead`, `cacheHitRate`, `tokensInput`, `effectiveInput`, `fullInputItems`, `lastAnchorId`, `recentCompaction`, and `actionTaken`.

## Acceptance Criteria

- A turn with `cache_read >= 50_000` and `cache_hit_rate >= 0.9` must not clear continuation solely due to relative cache-read drop.
- `<context_budget>` must distinguish uncached input from effective context (`tokens.input + cache.read`).
- `cache_cliff_detected` telemetry must report whether the action was `observe_only` or `invalidate_continuation`.
- Tests cover healthy high-hit-rate cache drops, true near-zero cliff, post-compaction shrink, and normal delta-tail turns.
