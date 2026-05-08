# Errors: fix-empty-response-rca

This spec deliberately **eliminates throw paths** rather than catalogues them. The "errors" here are operator-visible breadcrumbs and JSONL signals — never thrown exceptions that propagate out of the codex provider or trigger account rotation. Per design.md DD-2 / DD-3, the entire empty-turn cause family is now soft-fail-only.

## Error Catalogue

### REC-001 — Cache equilibrium detected (L1 signal)

| Field | Value |
|---|---|
| Code | `REC-001` |
| Where | JSONL entry at `<state>/codex/cache-equilibrium.jsonl` (per data-schema.json `CacheEquilibriumDetectionEvent`) + Bus channel `codex.cacheEquilibrium` |
| When | DD-1's cache-equilibrium-detector observes ≥ N consecutive identical `cache.read` values for a session (default N=3, configurable later) |
| Recovery | Informational only. The DD-1 fix itself prevents most equilibrium cases by deriving `predictedCacheMiss` from observable state; this signal exists to verify the fix works AND to catch any residue cases |
| Operator action | Investigate the `lockedCacheRead` value and `lastFinishedMessageIds`; cross-reference with session-DB to confirm whether DD-1 helper is being called correctly (was `predictedCacheMiss` derived as expected for those turns?) |
| Severity | Medium individual — equilibrium implies the loop bug is recurring; sustained pattern requires DD-1 root-cause re-investigation |

### REC-002 — WS error reason captured (DD-5 signal, NOT an error)

| Field | Value |
|---|---|
| Code | `REC-002` |
| Where | JSONL `wsErrorReason` field on empty-turn entries with `wsFrameCount: 0` (per data-schema.json wsErrorReason extension) |
| When | DD-2 routes `ws.onerror` / `ws.onclose` (frame=0) / `first_frame_timeout` through the classifier path; populates `wsErrorReason` with the verbatim reason string |
| Recovery | Already handled by classifier: `ws_no_frames` causeFamily + `retry-once-then-soft-fail`. The reason string is purely diagnostic |
| Operator action | Use M10 query to cluster wsErrorReason values; identifies network-level patterns (`WebSocket error`, `first_frame_timeout`, `ECONNREFUSED`, etc.) so operators can correlate with backend incidents or local network issues |
| Severity | Low individual / Medium clustered — sustained `WebSocket error` cluster might indicate codex backend instability; sustained `first_frame_timeout` might indicate cold-prefix-too-large issues (overlaps with L2 root-cause) |

### REC-003 — Rotation suppressed by empty-turn classification (DD-3 signal)

| Field | Value |
|---|---|
| Code | `REC-003` |
| Where | (NEW logging point added by DD-3 implementation) `console.log` line at `processor.ts:isModelTemporaryError` when guard returns false: `[ROTATION-GUARD] suppressed rotation: causeFamily=<X> sessionId=<Y> logSequence=<N>` |
| When | DD-3's guard fires: an exception reached processor.ts catch block, BUT the most recent finish part carried `providerMetadata.openai.emptyTurnClassification.causeFamily` |
| Recovery | Already handled by classifier upstream. Rotation is correctly NOT triggered. The log line is the audit trail showing the guard prevented an unwarranted rotation |
| Operator action | Use M9 query to count REC-003 occurrences vs total rotation attempts. Healthy state: REC-003 fires whenever empty turns occur; total rotations only fire on genuine 5xx/quota signals |
| Severity | Low — this is a defensive success signal; clusters of REC-003 indicate L2 throw-leak might still exist somewhere (DD-2's three-site coverage is incomplete and a fourth throw site exists). Cross-reference with REC-002 for affected sessions |

### REC-004 — Throw escaped from WS path (DD-2 violation)

| Field | Value |
|---|---|
| Code | `REC-004` |
| Where | NOT a JSONL signal — escapes only as a stack trace in opencode runtime stderr |
| When | A throw escaped the codex provider package from a WS-layer empty-turn path despite DD-2 plug. Indicates either (a) a fourth throw site DD-2 missed, OR (b) regression that re-introduced one of the three patched sites |
| Recovery | None — the throw reached processor.ts, was caught by isModelTemporaryError; if causeFamily metadata was on lastFinish, DD-3's guard caught it (REC-003 fires); if not, rotation triggered |
| Operator action | **CRITICAL** — investigate the stack trace, locate the throw site, file a new task on this spec's tasks.md to plug it. This is the regression watchdog for DD-2 |
| Severity | Critical individual — every occurrence indicates DD-2 is incomplete |

### REC-005 — predictedCacheMiss returned 'miss' on session with active cache

| Field | Value |
|---|---|
| Code | `REC-005` |
| Where | Could be added as a `console.warn` line in `derivePredictedCacheMiss` when it returns "miss" (DD-1 observability hook) |
| When | Helper was called with `continuationInvalidatedAt` set AND `lastFinished.tokens.cache.read === 0`; returns "miss" per DD-1 rule |
| Recovery | Already handled by DD-1: this is the expected output for genuinely degraded cache. cache-aware compaction triggers as before |
| Operator action | Cross-reference with REC-001 (cache equilibrium events). If REC-005 fires but no REC-001 follows, the system is recovering correctly. If REC-001 follows, equilibrium is forming despite DD-1 and needs investigation |
| Severity | Low — informational; high frequency could indicate codex backend cache invalidation issues (out-of-scope) |

## Excluded categories

The following are **deliberately not in this catalogue** because this spec eliminates rather than catalogues them:

- Thrown exceptions from WS-layer empty-turn paths — DD-2 makes these structurally impossible. Any occurrence is REC-004 (a regression signal, not a normal error)
- Account rotations triggered by empty-turn classifier output — DD-3 makes these structurally impossible. Any occurrence is the same regression class as REC-004
- AI SDK `controller.error()` calls from the empty-turn pipeline — preserved from codex-empty-turn-recovery's INV-01; same enforcement
- Codex backend HTTP error codes — surfaced verbatim in the existing `serverErrorMessage` field (data-schema.json from codex-empty-turn-recovery); not re-catalogued here
- Cache-equilibrium scenarios — DD-1 prevents them at the source; REC-001 is the watchdog signal for residue cases

## Cross-references

- codex-empty-turn-recovery [errors.md](../codex-empty-turn-recovery/errors.md) — predecessor catalogue (CET-001 through CET-006)
- codex-empty-turn-ws-snapshot-hotfix [errors.md](../codex-empty-turn-ws-snapshot-hotfix/errors.md) — sibling hotfix catalogue
- This spec extends the predecessor's "no hard-error" invariant by closing the WS-throw-leak that the predecessor missed
