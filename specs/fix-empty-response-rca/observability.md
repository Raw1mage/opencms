# Observability: fix-empty-response-rca

## Overview

This spec extends codex-empty-turn-recovery's observability surface in three ways:

1. New JSONL channel: `<state>/codex/cache-equilibrium.jsonl` for L1 detection events (DD-1)
2. New field on existing empty-turn JSONL: `wsErrorReason` for WS-layer-originated empty turns (DD-5)
3. New runtime breadcrumb: `[ROTATION-GUARD]` log line when DD-3 suppresses an unwarranted rotation (REC-003)

All additions are backward-compatible. Operators who don't update queries see no break; operators who add the new queries (M8/M9/M10) gain visibility into the L1+L2 fix's effectiveness.

## Events

### Event: `codex.cacheEquilibrium` (NEW Bus channel, DD-1)

| Field | Value |
|---|---|
| Channel | `codex.cacheEquilibrium` (in-process Bus) |
| Payload | Per `data-schema.json` `CacheEquilibriumDetectionEvent` (`schemaVersion: 1`); identical to JSONL line shape |
| Frequency | Per detection, NOT per turn. Fires only when N consecutive identical `cache.read` values are observed (default N=3) |
| Producer | `packages/opencode/src/session/prompt.ts` (cache-equilibrium-detector, alongside DD-1 helper) |
| Subscribers (current) | None mandated by this spec |
| Subscribers (future) | Admin panel L1 alert surface; telemetry shipper |
| Failure mode | Silent on publish failure; JSONL append is the load-bearing path (mirrors codex-empty-turn-recovery DD-2 / INV-06 pattern) |

### Event: `codex.emptyTurn` (existing channel, additive payload field)

Existing channel from codex-empty-turn-recovery. DD-5 extends the payload with `wsErrorReason: string | null`. Subscribers ignore unknown fields by default (additive; backward-compatible). No new subscriber required.

## Logs

### Log file: `<XDG_STATE_HOME>/opencode/codex/empty-turns.jsonl` (existing, extended)

Existing JSONL from codex-empty-turn-recovery. DD-5 adds optional `wsErrorReason` field on entries where `wsFrameCount: 0` AND a WS-layer event triggered the empty turn (`onerror`, `onclose-frame=0`, `first_frame_timeout`).

Schema version stays at 1 (additive). Existing readers ignore the new field. Operators can query it via M10.

### Log file: `<XDG_STATE_HOME>/opencode/codex/cache-equilibrium.jsonl` (NEW, DD-1)

| Field | Value |
|---|---|
| Path | `${XDG_STATE_HOME:-$HOME/.local/state}/opencode/codex/cache-equilibrium.jsonl` |
| Format | JSON Lines; conforms to `data-schema.json` `CacheEquilibriumDetectionEvent` (`schemaVersion: 1`) |
| Producer | cache-equilibrium-detector in `packages/opencode/src/session/prompt.ts` |
| Append mode | `O_APPEND`; mirrors empty-turn-log pattern; safe across processes within the same XDG state root |
| Rotation | External (logrotate or operator-managed); same conventions as empty-turns.jsonl |
| Failure mode | `console.error` breadcrumb similar to CET-001; recovery proceeds; the L1-detection event that triggered the failure is lost from JSONL but the equilibrium itself is still observable from the empty-turn JSONL channel (sustained `unclassified` cluster on the same session) |

### Console breadcrumbs

| Trigger | Format |
|---|---|
| DD-3 rotation suppression (REC-003) | `[ROTATION-GUARD] suppressed rotation: causeFamily=<X> sessionId=<Y> logSequence=<N>` |
| DD-1 derivePredictedCacheMiss returns "miss" with sticky context (REC-005) | `[CACHE-MISS-PREDICTION] miss returned despite continuationInvalidatedAt set: sessionId=<Y> lastCacheRead=<R>` |
| Cache-equilibrium-detector write failure | `[CACHE-EQUILIBRIUM] log emission failed: <reason>` (mirrors CET-001) |
| Throw escaped from WS path (REC-004) | (existing stack trace; no special prefix — investigate immediately) |

## Metrics

### Derivation policy

This spec adds no metrics protocol coupling. All metrics derive from JSONL via `jq` queries (mirrors codex-empty-turn-recovery's pattern). Operators run them on demand; external observability stacks tail the JSONL channels.

### M8 — Cache equilibrium incidents per session (DD-1 watchdog)

```bash
jq -s 'group_by(.sessionId) | map({
  sessionId: .[0].sessionId,
  count: length,
  maxConsecutive: map(.consecutiveTurns) | max,
  worstLockValue: map(.lockedCacheRead) | min
}) | sort_by(.count) | reverse' \
  < ${XDG_STATE_HOME:-$HOME/.local/state}/opencode/codex/cache-equilibrium.jsonl
```

Healthy state post-DD-1: low or zero hits. If a session shows multiple hits, DD-1 might have an edge case it doesn't cover (file a follow-up to revise design.md).

### M9 — Rotation events caused by empty turns (DD-2 + DD-3 watchdog)

This is the primary regression watchdog for Phase 1. Pre-fix baseline: rotation fired within 60s of empty-turn classifications. Post-fix expectation: zero.

Operator joins two sources (operator chooses rotation log source — could be `[CODEX-WS] CHAIN ...` log lines or rotation-event Bus subscriber output):

```bash
# Pseudo-jq join (operator adapts to actual rotation log format)
empty_turn_timestamps=$(jq -r '.timestamp' < ${XDG_STATE_HOME:-$HOME/.local/state}/opencode/codex/empty-turns.jsonl)

for ts in $empty_turn_timestamps; do
  # Find rotations within 60s of this empty-turn timestamp
  # Operator-defined query against rotation log
done

# Healthy result: 0 rotations within 60s windows
```

Phase 1 ship gate (handoff.md SG-5): if M9 > 0, DD-2 or DD-3 is incomplete; do not promote to verified.

### M10 — wsErrorReason cluster (DD-5 diagnostic)

```bash
jq -r 'select(.wsErrorReason != null) | .wsErrorReason' \
  < ${XDG_STATE_HOME:-$HOME/.local/state}/opencode/codex/empty-turns.jsonl \
  | sort | uniq -c | sort -rn
```

Identifies which network-level / WS-level failures dominate. If `WebSocket error` clusters, codex backend may be flapping. If `first_frame_timeout` clusters, cold-prefix-too-large might be the upstream cause (tie-in to L2 prewarm-on-rotation, which this spec defers).

### M11 — Rotation suppression rate (DD-3 visibility)

Counts how often DD-3's guard prevented an unwarranted rotation. Healthy: this number tracks closely with empty-turn-classification frequency on heavy-traffic sessions.

```bash
# From opencode runtime stderr / log capture
grep '\[ROTATION-GUARD\] suppressed rotation:' /path/to/opencode-runtime.log | wc -l
```

Cross-reference with M9: M11 fires whenever a throw reached processor.ts AND classifier metadata was on lastFinish. Sustained M11 with M9 > 0 means some throws bypass classifier metadata (possible regression).

## Alerts (recommended; not enforced by this spec)

| Alert | Condition | Severity |
|---|---|---|
| `CacheEquilibriumPersistent` | M8: a single session shows ≥ 3 incidents within 24h | Critical (DD-1 not catching the edge case) |
| `RotationFromEmptyTurn` | M9 > 0 over rolling 1h window | Critical (DD-2 / DD-3 regression — handoff.md SG-5 trips) |
| `WsErrorReasonSpike` | M10: total `WebSocket error` count > 3× rolling 7-day baseline | Warning (codex backend instability or local network) |
| `RotationGuardSilent` | empty-turn JSONL rate > 10 / hour BUT M11 = 0 over the same window | Critical (DD-3 not firing — guard might be unwired) |
| `ThrowEscapedFromWS` | REC-004 stack trace appears in opencode runtime log | Critical (DD-2 incomplete — locate the leaked throw site) |

## Health check

Operator can validate post-deploy in two minutes:

```bash
# 1. New daemon up
tail -1 ~/.local/state/opencode/daemon-startup/startup.jsonl

# 2. New empty-turn JSONL entries (if any) include wsErrorReason field where applicable
jq 'select(.wsFrameCount == 0)' ~/.local/state/opencode/codex/empty-turns.jsonl | tail -1

# 3. Cache-equilibrium JSONL exists (if Phase 2 deployed); empty file is fine
ls -la ~/.local/state/opencode/codex/cache-equilibrium.jsonl 2>/dev/null

# 4. No REC-004 stack traces in recent runtime stderr
journalctl --user -u opencode-gateway.service --since "1 hour ago" 2>/dev/null | grep -i "throw" || echo "clean"
```

## Cross-references

- codex-empty-turn-recovery [observability.md](../codex-empty-turn-recovery/observability.md) — M1 through M7 metrics from the predecessor (M8 through M11 here continue the numbering)
- codex-empty-turn-ws-snapshot-hotfix [observability.md](../codex-empty-turn-ws-snapshot-hotfix/observability.md) — sibling hotfix; DD-5 wsErrorReason field is the natural continuation of that hotfix's wsFrameCount restoration
- [docs/runbooks/codex-empty-turn-log-runbook.md](../../docs/runbooks/codex-empty-turn-log-runbook.md) — operator runbook gains M8/M9/M10/M11 sections per Phase 3 task 3.2
