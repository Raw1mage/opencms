# Observability

## Events

### E.PHASE1.APPLIED — info-level
- **When**: Transformer runs successfully
- **Fields**: `sessionID`, `step`, `flagEnabled`, `recentRawRounds`, `transformedTurns`, `traceMarkerCount`, `cacheRefHits`, `cacheRefMisses`, `inputItemsBefore`, `inputItemsAfter`
- **Purpose**: Verify transformer firing; quantify reduction

### E.PHASE1.SKIPPED — debug-level
- **When**: Flag off, or subagent path, or no anchor present
- **Fields**: `sessionID`, `reason` (`flag-disabled` | `subagent-path` | `no-anchor` | `unsafe-boundary`)
- **Purpose**: Verify gating logic for negative cases

### E.PHASE1.FALLBACK — warn-level
- **When**: Safety net fires (DD-4)
- **Fields**: `sessionID`, `step`, `threshold`, `transformedCount`
- **Purpose**: Detect over-aggressive transformation; tune threshold

### E.PHASE1.CACHE_MISS — warn-level
- **When**: Trace marker can't resolve WorkingCache reference
- **Fields**: `sessionID`, `step`, `toolCallId`, `toolName`, `turnIndex`, `lazyWriteAttempted`, `lazyWriteResult`
- **Purpose**: Detect coverage gaps in WorkingCache indexing

### E.PHASE1.LAYER_PURITY_VIOLATION — error-level (throws)
- **When**: Forbidden key detected in trace marker text (DD-7)
- **Fields**: `sessionID`, `step`, `forbiddenKey`, `originalMessageId`, `turnIndex`
- **Purpose**: Architectural regression detector; throwing aborts prompt assembly

## Metrics

(suggested counters for follow-up; Phase 1 implementation may use logs only first, metrics later)

- `compaction_phase1_applied_total{sessionId}` — count of successful transforms per session
- `compaction_phase1_input_items_before_after` — histogram of (before, after) item counts
- `compaction_phase1_fallback_total{reason}` — count of fallback events
- `compaction_phase1_cache_miss_total{tool}` — count of WorkingCache misses by tool name

## Logs

Structured log lines emitted via `Log.create({ service: "session.prompt" })`:

```
[INFO] phase1-transform: applied sessionID=... transformedTurns=28 cacheRefHits=84 cacheRefMisses=2 inputItemsBefore=347 inputItemsAfter=78
[DEBUG] phase1-transform: skipped sessionID=... reason=subagent-path
[WARN] phase1-transform: fallback to raw sessionID=... threshold=5 got=3
[WARN] phase1-transform: cache miss sessionID=... toolName=read turnIndex=12 lazyWriteResult=ok
[ERROR] phase1-transform: layer purity violation forbiddenKey=previous_response_id originalMessageId=msg_xxx
```

## Alerts

Phase 1 does not introduce paging alerts. After 24h soak baseline:
- If E.PHASE1.FALLBACK rate > 1% of transform invocations → manual review
- If E.PHASE1.LAYER_PURITY_VIOLATION ever fires → page (architectural regression)
- If E.PHASE1.CACHE_MISS rate > 5% of trace markers → investigate WorkingCache coverage

## Operator Queries

### Q-M11: Phase 1 firing rate per session

```bash
grep "phase1-transform: applied" $LOG_FILE | jq -s 'group_by(.sessionID) | map({sessionID: .[0].sessionID, count: length, avgBefore: (map(.inputItemsBefore) | add / length), avgAfter: (map(.inputItemsAfter) | add / length)})'
```

### Q-M12: Cache miss heatmap by tool

```bash
grep "phase1-transform: cache miss" $LOG_FILE | jq -s 'group_by(.toolName) | map({tool: .[0].toolName, misses: length})'
```

### Q-M13: Empty-turn failure rate post-Phase-1 (compares against fix-empty-response-rca baseline)

```bash
jq -c 'select(.timestamp >= "2026-05-08T00:00Z" and (.requestOptionsShape.phase1TransformApplied == true)) | {cause: .causeFamily, frames: .wsFrameCount}' ~/.local/state/opencode/codex/empty-turns.jsonl
```

## Soak Verification (per handoff.md SG-7)

24-hour soak window with `phase1Enabled=true` for at least one real session:
- failure rate (Q-M13 vs fix-empty-response-rca baseline 0.71%): expectation `≤ 0.71%`
- E.PHASE1.LAYER_PURITY_VIOLATION count: expectation `0`
- E.PHASE1.FALLBACK rate: expectation `< 1%` of transforms
- avg `inputItemsAfter / inputItemsBefore` ratio: expectation `< 0.4` (target ~0.25)
