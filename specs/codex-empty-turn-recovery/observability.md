# Observability: codex-empty-turn-recovery

## Overview

This spec's observability surface has one load-bearing channel (JSONL log file) and one convenience channel (in-process bus), both carrying the same payload conforming to [data-schema.json](data-schema.json). All operationally meaningful state about empty-turn classification and recovery flows through these two channels.

## Events

### Event: `codex.emptyTurn` (Bus channel)

| Field | Value |
|---|---|
| Channel | `codex.emptyTurn` (in-process Bus) |
| Payload | Identical to JSONL log entry; conforms to [data-schema.json](data-schema.json) |
| Frequency | One per empty-turn classification (which is a strict subset of total assistant turns) |
| Producer | [empty-turn-log.ts](../../packages/opencode-codex-provider/src/empty-turn-log.ts) |
| Subscribers (current) | None mandated by this spec |
| Subscribers (future) | Admin panel real-time view; telemetry shipper to external observability stack |
| Failure mode | Silent on publish failure (see CET-002 in errors.md); JSONL append is independent and remains the load-bearing path |

## Logs

### Log file: `<XDG_STATE_HOME>/opencode/codex/empty-turns.jsonl`

| Field | Value |
|---|---|
| Path | `${XDG_STATE_HOME:-$HOME/.local/state}/opencode/codex/empty-turns.jsonl` |
| Format | JSON Lines (one entry per line; conforms to [data-schema.json](data-schema.json)) |
| Producer | [empty-turn-log.ts](../../packages/opencode-codex-provider/src/empty-turn-log.ts) `appendEmptyTurnLog()` |
| Append mode | `O_APPEND`; safe across multiple processes within the same XDG state root |
| Rotation | External (logrotate or operator-managed) per DD-3; suggested config: weekly rotate + 90-day retention; documented in operator runbook by Phase 4 task 4.2 |
| Failure mode | `console.error` breadcrumb (CET-001 in errors.md); recovery proceeds; the empty-turn entry that triggered the failure is lost from JSONL but bus subscribers (if any) still received it |
| Read access | Plain text; `tail -f`, `jq`, `grep` all work; no special tooling required |

### Log line schema-compliance check

Every line in the file MUST validate against [data-schema.json](data-schema.json) (`schemaVersion: 1`). Schema-drift unit test (Phase 2 task 2.9) prevents accidental enum drift.

Operator quick-check command:
```bash
jq -e '.causeFamily' < ~/.local/state/opencode/codex/empty-turns.jsonl | sort | uniq -c
```

### Log entry minimum fields

(Fully specified in data-schema.json; reproduced here for operator orientation):

- `timestamp` — ISO-8601 UTC
- `logSequence` — monotonic per-process counter; primary join key for retry pairs
- `sessionId` / `messageId` — opencode session + message references
- `accountId` — codex account assigned (may be null)
- `causeFamily` — one of six enum values
- `recoveryAction` — one of four enum values
- `wsFrameCount` / `terminalEventReceived` / `terminalEventType`
- `deltasObserved` (counts by type)
- `requestOptionsShape` (sanitized)
- `streamStateSnapshot` (forensic state)

### Console error breadcrumbs

| Trigger | Format |
|---|---|
| JSONL write failure (CET-001) | `[CODEX-EMPTY-TURN] log emission failed: <reason>` |
| Classifier returned unknown action (CET-003) | `[CODEX-EMPTY-TURN] classifier returned unrecognized recoveryAction "<value>"; falling back to pass-through-to-runloop-nudge` |

These are emitted via `console.error`; they appear in opencode runtime stdout/stderr per existing logging conventions.

## Metrics

### Derivation policy

This spec does not directly emit a metrics protocol (Prometheus, OTel, etc.). Metrics are **derivable on-demand from the JSONL log** — the `data-schema.json` payload already contains all source signals; operators run `jq`/`grep` queries (see M1-M7 below) when they need a metric, and any external observability stack can derive the same metrics by tailing the JSONL file. This keeps the provider package free of metrics-protocol coupling and lets each operator pick their stack.

### M1 — Empty-turn rate

```bash
# Empty turns per hour, last 24h
jq -r '.timestamp | sub("(?<dt>.{13}).*"; "\(.dt)")' \
  < empty-turns.jsonl | sort | uniq -c
```

### M2 — Cause-family distribution

```bash
jq -r '.causeFamily' < empty-turns.jsonl | sort | uniq -c | sort -rn
```

### M3 — Retry rate (signal for SG-5)

```bash
total_ws_truncation=$(jq -s 'map(select(.causeFamily=="ws_truncation")) | length' < empty-turns.jsonl)
retried=$(jq -s 'map(select(.retryAttempted == true)) | length' < empty-turns.jsonl)
echo "scale=4; $retried / $total_ws_truncation" | bc
```

If output > 0.20 → SG-5 stop gate activates; halt rollout.

### M4 — Soft-fail rate (`retryAlsoEmpty`)

```bash
jq -s 'map(select(.retryAlsoEmpty == true)) | length' < empty-turns.jsonl
```

Sustained non-zero indicates upstream codex degradation; correlate with codex incident reports.

### M5 — D-3 audit signal: server_empty_output_with_reasoning rate

```bash
total=$(jq -s 'length' < empty-turns.jsonl)
ser=$(jq -s 'map(select(.causeFamily=="server_empty_output_with_reasoning")) | length' < empty-turns.jsonl)
echo "scale=4; $ser / $total"
```

If output ≥ 0.05 over 7-day window → trigger D-3 `extend` revision per spec.md `Audit-before-omit` Requirement.

### M6 — Account-correlated empty-turn rate (signal for cross-cutting account rotation issue)

```bash
jq -r '.accountId' < empty-turns.jsonl | sort | uniq -c | sort -rn
```

If a single accountId dominates → that account may be degraded (stale OAuth, throttled, etc.). Cross-reference with `project_codex_stale_oauth.md` patterns.

### M7 — Suspect-param frequency (D-3 audit detail)

```bash
jq -r '.requestOptionsShape.suspectParams[]' < empty-turns.jsonl | sort | uniq -c | sort -rn
```

Identifies which request parameters most frequently correlate with empty-output causes — surfaces the param to omit for codex-subscription tier, when D-3 threshold met.

## Alerts (recommended; not enforced by this spec)

This spec does not define alert thresholds because alerting policy lives in the operator's chosen observability stack. The following are recommendations:

| Alert | Condition | Severity |
|---|---|---|
| `EmptyTurnSpike` | Empty-turn rate (M1) > 3× rolling 7-day baseline | Warning |
| `RetrySaturation` | Retry rate (M3) > 0.20 sustained for 1h | Critical (matches SG-5) |
| `LogChannelFailure` | CET-001 console.error appears in opencode runtime logs | Critical (evidence loss) |
| `D3AuditThresholdReached` | M5 ≥ 0.05 over 7-day rolling window | Action-required (trigger extend mode) |
| `UnclassifiedClusterEmerging` | M2 `unclassified` count > 50 within 24h | Warning (propose new enum value) |

## Dashboards (recommended)

If integrating with a dashboard system (Grafana / similar), suggested panels:

1. **Empty-turn rate over time** (M1) — area chart, hourly granularity
2. **Cause-family stack** (M2) — stacked area, normalized to 100%, hourly granularity
3. **Retry pair tracker** (M3 + M4) — two-line chart: retry rate vs soft-fail rate
4. **D-3 audit indicator** (M5) — single-stat with threshold colouring
5. **Top-5 unclassified stream-state shapes** — derived by hashing `streamStateSnapshot` and counting hash frequency; surfaces emerging cause patterns

These dashboards are out of scope for this spec to construct, but the JSONL log provides all the source data for them.

## Health check

A simple operator health probe:

```bash
# Should produce non-zero output if the file exists and any classification has occurred
jq -s 'length' < ~/.local/state/opencode/codex/empty-turns.jsonl
```

Absence of the file (or empty file) after a long uptime period is itself diagnostic — either no empty turns have occurred (good), or the log channel was misconfigured at startup (investigate via CET-001 breadcrumbs in opencode runtime logs).
