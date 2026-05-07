# Spec: fix-empty-response-rca (Phase 1: L1 + L2)

## Purpose

Eliminate the two empty-response root causes that codex-empty-turn-recovery's result-layer fix could not address:

- **L1** — Compaction `predictedCacheMiss` flag becomes sticky once `continuationInvalidatedAt` is ever set, causing cache-aware compaction to fire every turn and produce a deterministic compressed prefix that locks into a 36352–37888 cache_read equilibrium. Codex sees the same prefix bytes every turn; the model re-plans from the same compacted snapshot; loop sustains.
- **L2** — Account rotation thrash via `ws.onerror` → `endWithError("WebSocket error")` throw. The throw escapes the codex provider package (violating INV-01 in spirit at the WS layer), reaches `processor.ts:149` `isModelTemporaryError()` which classifies it as a temporary backend error, and triggers `handleRateLimitFallback()` → `findFallback()` → account rotation. The rotation drops the session into a cold cache_key on the new account, repeats the truncation, propagates the loop across multiple accounts.

Out-of-scope landmines (deferred per existing Scope Refinement Backlog in proposal.md): L3 (store=false × retry, P2), L4 (rotation thrash via finishReason — already prophylactically guarded, P3), L7 (cross-round empty observability, P3).

## Definitions

- **Compaction equilibrium**: a state where successive compaction operations produce the bytes-identical compressed prefix despite new turns being added. Observable: `cache_read` from codex stays at the same value across many consecutive turns; `tokens_input` cycles in a small range without growing.
- **Throw-leak from WS layer**: `transport-ws.ts:wsRequest` calls `endWithError(new Error(...))` instead of routing through the empty-turn classifier. The error propagates up to `provider.ts.doStream`, escapes the codex provider package, and is caught by `processor.ts` as a generic provider error subject to `isModelTemporaryError()` heuristics.
- **Rotation cold prefix**: when account A is replaced by account B mid-session, the `prompt_cache_key` (formula `codex-${accountId}-${sessionId}`) changes, so codex backend treats the conversation as a brand-new prefix and must recompute everything. cache_read drops to 0 on the new account's first turn.

## Requirements

### Requirement: predictedCacheMiss flag is not sticky across turns

#### Scenario: continuationInvalidatedAt is set, compaction recovers cache

- **GIVEN** `session.execution.continuationInvalidatedAt` was set on turn N due to codex rejecting `previous_response_id`
- **AND** turn N+1 ran cache-aware compaction successfully
- **WHEN** turn N+2 evaluates `predictedCacheMiss`
- **THEN** the flag MUST NOT default to `"miss"` solely because `continuationInvalidatedAt` is non-null
- **AND** the flag MUST be derived from observable cache state on the most recent successful turn (e.g., `lastFinished.tokens.cache.read > 0` indicates cache is alive)

#### Scenario: cache_read locked across multiple consecutive turns

- **GIVEN** `lastFinished.tokens.cache.read` returned an identical value for ≥ 3 consecutive turns
- **WHEN** the cache-aware compaction trigger evaluates
- **THEN** the trigger MUST recognize the stuck-equilibrium pattern and either (a) skip compaction this turn, OR (b) force a different compaction strategy that breaks the deterministic output

#### Scenario: post-compaction cache invalidation marker cleared

- **GIVEN** a cache-aware compaction completed and the next codex turn returned non-zero `tokens.cache.read`
- **WHEN** subsequent turns evaluate `predictedCacheMiss`
- **THEN** the `continuationInvalidatedAt` marker MUST be cleared OR treated as resolved
- **AND** subsequent turns MUST NOT re-trigger cache-aware compaction solely because of the historical marker

### Requirement: WS-layer errors never propagate as exceptions to the runloop

#### Scenario: ws.onerror fires before any frame received

- **GIVEN** `transport-ws.ts:wsRequest` opens a WebSocket
- **AND** `ws.onerror` fires while `wsObs.frameCount === 0`
- **WHEN** the error handler executes
- **THEN** the handler MUST NOT call `endWithError(new Error("WebSocket error"))`
- **AND** the handler MUST route the failure through the same classifier path as `ws.onclose` (causeFamily `ws_no_frames`, recoveryAction `retry-once-then-soft-fail`)
- **AND** the empty-turn JSONL log entry MUST include the error reason (new field `wsErrorReason: string | null` on TransportSnapshot)
- **AND** the SSE pipeline MUST emit a normal finish part with classification metadata, not an exception

#### Scenario: ws.onclose fires before any frame received

- **GIVEN** `ws.onclose` fires with `wsObs.frameCount === 0` and `state.status === "streaming"`
- **WHEN** the close handler executes
- **THEN** the handler MUST NOT call `endWithError(new Error("WS closed before response"))`
- **AND** the handler MUST route through the classifier path identically to the `ws.onerror` zero-frame case

#### Scenario: idle timeout fires before any frame

- **GIVEN** `resetIdleTimer` fires its callback with `wsObs.frameCount === 0`
- **WHEN** the timeout handler currently calls `controller.error(new Error("Codex WS: first_frame_timeout"))` at `transport-ws.ts:289`
- **THEN** the handler MUST instead route through the classifier (causeFamily `ws_no_frames` with `wsErrorReason: "first_frame_timeout"`)

#### Scenario: empty turn no longer triggers rotation

- **GIVEN** an empty turn was classified by the codex-empty-turn-recovery classifier (any cause family)
- **WHEN** the runloop evaluates whether to rotate accounts
- **THEN** the runloop MUST NOT enter `handleRateLimitFallback()` purely because an empty turn occurred
- **AND** rotation MUST remain available for genuine rate-limit / quota / 5xx signals (not classifier output)

### Requirement: rotation reads classifier metadata before treating provider failures as account-degradation

#### Scenario: provider error has emptyTurnClassification metadata

- **GIVEN** a provider error reached `processor.ts:isModelTemporaryError()`
- **AND** the most recent finish part had `providerMetadata.openai.emptyTurnClassification` populated
- **WHEN** `isModelTemporaryError()` evaluates
- **THEN** if causeFamily is in `{ws_truncation, ws_no_frames, server_empty_output_with_reasoning, server_incomplete, server_failed, unclassified}`, the result MUST be `false` (not a temporary error worth rotating away from)
- **AND** the runloop MUST surface the empty-turn nudge instead of rotating

### Requirement: no historical mutation; only forward effects

#### Scenario: pre-fix sessions remain as-is

- **GIVEN** sessions that ran before this fix landed
- **WHEN** the fix deploys
- **THEN** historical session storage and JSONL entries MUST remain unchanged
- **AND** documentation MUST state the historical evidence cannot be retroactively corrected

## Acceptance Checks

- **A1**: ses_204499eecffe2iUTzeXyiarlnq replay scenario (or equivalent synthetic): cache_read does not lock at a constant value for ≥ 3 consecutive turns post-fix.
- **A2**: WS truncation event no longer triggers account rotation. Specifically: when ws.onerror fires with frameCount=0, no `handleRateLimitFallback` is called, no new account is selected, and the same account continues for the next turn.
- **A3**: empty-turns.jsonl includes the new `wsErrorReason` field for ws_no_frames events that originated from ws.onerror or first_frame_timeout.
- **A4**: 105+ existing codex-provider tests + 2 boundary regression tests still pass; new tests added for L1 trigger and L2 throw-elimination.
- **A5**: Live deploy + 24h soak: zero new account-rotation events caused by empty-turn errors. Operators verify by joining empty-turn JSONL with rotation logs over the soak window.
- **A6**: provider boundary (INV-16 from codex-empty-turn-recovery) preserved — the `isModelTemporaryError` change in opencode runtime reads `providerMetadata` as opaque metadata, not by importing codex provider types.

## Out of Contract

- L3 (store=false × retry interaction): deferred; will be evaluated separately after L1+L2 land
- L4 prophylactic hardening: this spec already addresses the practical L4 path (the throw-leak); the original "if rotation ever reads finishReason" defense is moot
- L7 observability metrics: deferred to a separate spec
- prewarm-on-rotation: deferred; the throw-leak fix removes most rotations triggered by empty turns, so prewarm becomes lower-priority
- Codex backend behavior (the actual root cause of WS truncations): out of our control
