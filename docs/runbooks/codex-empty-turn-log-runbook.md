# Codex Empty-Turn Log Runbook

**Audience:** operators of an opencode deployment.
**Spec:** [specs/codex-empty-turn-recovery/](../../specs/codex-empty-turn-recovery/) (state: implementing → verified after live deployment confirms invariants).

## What this log is

Forensic JSONL trail for every empty assistant turn returned from the codex backend. Each line is one classification + recovery decision per the spec's data schema. The file is the **load-bearing evidence path** (Decision D-2): if you need to know whether the codex backend is degraded, why a session looked stuck, or whether the OpenHands #2797 reasoning-param exposure is real on your tenant, this file is the primary source.

The bus channel `codex.emptyTurn` mirrors entries non-load-bearingly for live consumers (admin panel, telemetry shipper). Absence of bus subscribers does NOT cause data loss — JSONL append is independent and runs first.

## File location

```
$XDG_STATE_HOME/opencode/codex/empty-turns.jsonl
```

If `XDG_STATE_HOME` is unset, the default is `~/.local/state/opencode/codex/empty-turns.jsonl`. The codex-provider creates the parent directory on first append (idempotent).

For multi-user deployments where each opencode runtime user has their own XDG state root, each user gets their own file. There is no shared global file.

## Schema

Conforms to [specs/codex-empty-turn-recovery/data-schema.json](../../specs/codex-empty-turn-recovery/data-schema.json) (`schemaVersion: 1`). One JSON object per line, append-only, never edited in place. Required fields:

- `timestamp` — ISO-8601 UTC
- `logSequence` — monotonic per-process counter (resets on daemon restart)
- `sessionId` / `messageId` / `accountId` / `providerId` / `modelId`
- `causeFamily` — one of six enum values
- `recoveryAction` — one of four enum values
- `wsFrameCount` / `terminalEventReceived` / `terminalEventType` / `wsCloseCode` / `wsCloseReason`
- `serverErrorMessage` (when applicable)
- `deltasObserved` (counts by event type)
- `requestOptionsShape` (sanitized — no PII, no tokens)
- `streamStateSnapshot` (forensic state)

Optional retry fields when present:
- `retryAttempted` / `retryAlsoEmpty` / `previousLogSequence`

## Rotation policy (REQUIRED — operators must configure)

The codex-provider does NOT rotate this file. External rotation MUST be configured because the file grows monotonically; an empty turn weighs ~1-2 KB per entry, so at 1 turn/min the file reaches ~1 GB/year.

Suggested `logrotate` config for Linux:

```
$XDG_STATE_HOME/opencode/codex/empty-turns.jsonl {
    weekly
    rotate 12
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

`copytruncate` is preferred over `create` because the codex-provider holds an `O_APPEND` file handle for the lifetime of the daemon process; a `create`-mode rotate would orphan the handle. With `copytruncate`, the handle stays valid and continues appending to the truncated file.

Alternative: a daily `cron` job that rotates if size exceeds a threshold (e.g., 100 MB).

## Health check

```bash
# Should be > 0 if any empty turn has occurred since last rotation
jq -s 'length' < $XDG_STATE_HOME/opencode/codex/empty-turns.jsonl
```

Empty file (or missing file) after a long uptime is itself diagnostic — either no empty turns happened (good) OR the path was misconfigured at startup. Check opencode runtime logs for the `[CODEX-EMPTY-TURN] log emission failed:` breadcrumb (CET-001).

## Operator queries (mirrors observability.md M1-M7)

### M1 — Empty-turn rate per hour, last 24h

```bash
jq -r '.timestamp | sub("(?<dt>.{13}).*"; "\(.dt)")' \
  < empty-turns.jsonl | sort | uniq -c
```

### M2 — Cause-family distribution

```bash
jq -r '.causeFamily' < empty-turns.jsonl | sort | uniq -c | sort -rn
```

### M3 — Retry rate (signal for SG-5 stop gate)

```bash
total_ws=$(jq -s 'map(select(.causeFamily | startswith("ws_"))) | length' < empty-turns.jsonl)
retried=$(jq -s 'map(select(.retryAttempted == true)) | length' < empty-turns.jsonl)
echo "scale=4; $retried / $total_ws" | bc
```

If output > 0.20 sustained → SG-5 stop gate (broad codex degradation). Halt rollout, escalate.

### M5 — D-3 audit signal: server_empty_output_with_reasoning rate

```bash
total=$(jq -s 'length' < empty-turns.jsonl)
ser=$(jq -s 'map(select(.causeFamily=="server_empty_output_with_reasoning")) | length' < empty-turns.jsonl)
echo "scale=4; $ser / $total" | bc
```

If output ≥ 0.05 over 7-day window → trigger D-3 `extend` mode revision to add codex-subscription parameter omission.

### M6 — Account-correlated empty-turn rate

```bash
jq -r '.accountId' < empty-turns.jsonl | sort | uniq -c | sort -rn
```

A single accountId dominating → that account may be degraded (stale OAuth, throttled). Cross-reference with `project_codex_stale_oauth.md` patterns.

### M7 — Suspect-param frequency (D-3 audit detail)

```bash
jq -r '.requestOptionsShape.suspectParams[]?' < empty-turns.jsonl | sort | uniq -c | sort -rn
```

Identifies which request parameter most frequently correlates with empty-output causes.

## Alert thresholds (recommended)

| Alert | Condition | Severity |
|---|---|---|
| EmptyTurnSpike | M1 > 3× rolling 7-day baseline | Warning |
| RetrySaturation | M3 > 0.20 sustained for 1h | Critical (SG-5) |
| LogChannelFailure | CET-001 console.error in opencode runtime logs | Critical (evidence loss) |
| D3AuditThreshold | M5 ≥ 0.05 over 7-day rolling window | Action-required (extend mode) |
| UnclassifiedClusterEmerging | M2 unclassified count > 50 / 24h | Warning (propose new enum value) |

## What NOT to do

- **Do NOT delete this file mid-investigation.** Append-only by design — historical lines are part of the audit trail.
- **Do NOT edit lines in place.** They must validate against the schema. If you need to fix a bad entry, append a corrective entry, never mutate.
- **Do NOT manually inject entries.** The classifier is the only legitimate writer.
- **Do NOT tail the bus channel as authoritative.** Bus is convenience (DD-2 / INV-06); a dropped subscriber loses data. JSONL is the source of truth.
