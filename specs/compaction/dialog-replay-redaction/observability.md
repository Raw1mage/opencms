# Observability: dialog-replay-redaction

## Events

### compaction.recompressed (NEW)

**Surface**: Bus.publish channel `compaction.recompressed`; mirrored into `bus.session.telemetry.updated` projector.

**Schema**: per `data-schema.json` RecompressTelemetryEvent.

**Fires when**: `runCodexServerSideRecompress` or `runHybridLlmRecompress` completes (success or failure).

**Fields**:
- `sessionID` — always set.
- `trigger` — `"size-ceiling"` (anchor > ceiling) or `"legacy-large-policy"` (legacy enrichment-when-large policy retained for back-compat).
- `kind` — `"low-cost-server"` or `"hybrid_llm"`.
- `providerId` — model.providerId at dispatch.
- `anchorTokensBefore` — estimated tokens at dispatch.
- `anchorTokensAfter` — set on success; estimated tokens of LLM-distilled body.
- `result` — `"success" | "stale-anchor-skipped" | "provider-error" | "timeout" | "exception"`.
- `errorMessage` — set when `result !== "success" && result !== "stale-anchor-skipped"`.
- `latencyMs` — wall-clock dispatch duration.

**Subscribers**:
- Frontend Q card session telemetry (renders the latest recompress event).
- Future: dashboard for anchor health.

### compaction.completed (EXISTING — schema unchanged)

Pre-existing event; this spec does not modify it. The recompress is async/background and emits its own dedicated event.

### bus.session.updated (EXISTING — `recentEvents` field shape extended)

The `execution.recentEvents` ring buffer entries previously had:

```ts
{ ts: number; kind: "compaction"; compaction: { observed: string; success: boolean; ... } }
```

After this spec, additionally:

```ts
{ ts: number; kind: "compaction-recompress"; recompress: { result: string; kind: "low-cost-server" | "hybrid_llm"; anchorTokensBefore: number; anchorTokensAfter?: number } }
```

Existing kinds remain unchanged. Subscribers should treat the discriminated union variant as additive. Spec 1's `compaction-replay` variant also coexists.

## Metrics

### compaction.recompressed.result

**Type**: counter, labels `{result, kind, providerId}`.

**Source**: derived from `compaction.recompressed` event stream.

**Use**: detect regression spikes — `result="exception"` rate spike indicates LLM-side issue; `stale-anchor-skipped` spike indicates concurrent-compaction problem.

**Alert thresholds (recommended)**:
- `result="exception"` rate > 1% of dispatches over 1 hour → investigate.
- `result="stale-anchor-skipped"` rate > 5% sustained → too many concurrent compactions per session; investigate scheduling.

### compaction.anchor.tokens_estimated (DERIVED)

**Type**: histogram, labels `{providerId}`.

**Source**: anchor body length / 4 (chars-based heuristic) sampled at every compaction commit + recompress dispatch.

**Use**: monitor anchor size distribution. p99 should stay < `anchorRecompressCeilingTokens` × 1.5 (oversize tolerated for one cycle before recompress kicks in).

**Alert thresholds**:
- p99 > 75K sustained for codex sessions → recompress not firing or failing; investigate CRR-001 / CRR-002.
- p99 > 150K → emergency: anchor body unbounded; toggle feature flag off.

### compaction.recompressed.latency_ms

**Type**: histogram, labels `{kind, providerId, result}`.

**Source**: `latencyMs` field of `compaction.recompressed` event.

**Use**: SLO for recompress dispatch.

**Targets**:
- `kind="low-cost-server"` p99 < 5s (codex /responses/compact is server-side and should be fast).
- `kind="hybrid_llm"` p99 < 30s (LLM compaction generates; longer is expected).

### compaction.amnesia_signal (DERIVED — manual / qualitative)

**Source**: model behaviour pattern: refusing to reference prior assistant turns ("I don't have that context"); generic Continue follow-ups when specific answers were expected.

**Use**: hard regression signal — pre-v7 this was the dominant failure mode for multi-task sessions; post-v7 should approach zero.

**Detection method**: manual review of session transcripts during rollout; no automatic metric.

### compaction.anchor_round_number_max (DERIVED — diagnostic)

**Type**: gauge per session.

**Source**: highest `## Round N` parsed from latest anchor body via `parsePrevLastRound`.

**Use**: validates round-numbering monotonicity (M7-5 evidence). Should be strictly increasing within a session except across recompress boundaries (where OQ-1 fallback may reset).

### recall_toolcall_raw.miss_count (NEW — load-bearing)

**Type**: counter.

**Source**: count of `working-cache.deriveLedger` lookups that fail to resolve a `part.id`.

**Use**: validates DD-9 recall-flow assumption. Pre-spec baseline: zero (no production usage of recall via redacted anchor body). Post-spec: should stay near zero.

**Alert**: ANY sustained miss > 1/min → CRR-006 occurring; investigate storage layer. Could indicate corruption.

## Dashboards (recommended, not required)

- **Anchor health overview** — combine `compaction.anchor.tokens_estimated` p99, `compaction.recompressed.result` breakdown, `compaction.recompressed.latency_ms` p99. Single dashboard answers "are anchors bounded and recompressing healthily?".
- **Recompress outcomes pie** — share of success / stale-anchor-skipped / provider-error / exception per provider. Spot regressions.
- **Session-level event timeline** — uses `recentEvents` projection (already exists in Q card); the new `compaction-recompress` variant should appear adjacent to `compaction` and `compaction-replay` events.

## Logs

All log lines use the `service: "session.compaction"` prefix per existing convention.

**INFO level**:
- `recompress.skip: below-floor` — anchor < 5K, no recompress.
- `recompress.skip: stale-anchor` — CRR-003.
- `recompress.dispatch: <kind>` — successful dispatch start.
- `recompress.complete: success` — completed with anchor body update.
- `parsePrevLastRound: no round markers` — CRR-005 fallback.

**WARN level**:
- `recompress: codex /responses/compact failed` (CRR-001).
- `recompress: hybrid_llm failed` (CRR-002).
- `serializeRedactedDialog: excludeUserMessageID not found in tail` (CRR-004).

**ERROR level**:
- `recall_toolcall_raw: part id not found in ledger` (CRR-006).

All ERROR-level log entries include the full forensic shape: `{ sessionID, partId, anchorMessageID, error }`.

## Sampling / Retention

- Bus events: ephemeral (in-process EventEmitter; subscribers consume in real-time).
- `recentEvents` ring buffer: bounded by existing per-session capacity (typically last 50 events).
- debug.log: rotated per-process; retention per system config.

No new persistent log files introduced by this spec.

## Cross-spec coordination

- Spec 1 (`user-msg-replay-unification`) emits `compaction.user_msg_replay`. Both events fire on the same compaction commit:
  1. `compaction.completed` (existing) — anchor written.
  2. `compaction.user_msg_replay` (Spec 1) — unanswered user msg replayed.
  3. `compaction.recompressed` (Spec 2) — async, fires later when recompress dispatch finishes (if anchor > 50K).
- Order is informative for telemetry consumers; subscribers should treat events independently.
