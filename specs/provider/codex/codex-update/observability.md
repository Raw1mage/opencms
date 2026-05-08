# Observability: codex-update

## Events

### New Log Lines

### `[CODEX-WS] REQ ... thread_id=<...>`

Existing `[CODEX-WS] REQ` log line is extended with a new field `thread_id=<value>`.

- File: `packages/opencode-codex-provider/src/transport-ws.ts` near line 325
- Format: append ` thread_id=${threadId}` after existing `session_id` field
- Purpose: confirm at runtime that thread_id is being emitted; supports the live-smoke acceptance check in spec.md

### `[CODEX-WS] WS send timeout session=<id> thread=<id> err=ws_send_timeout`

New log line emitted when send-side idle timeout fires.

- File: `packages/opencode-codex-provider/src/transport-ws.ts` (in the ws_send_timeout handler)
- Level: warn
- Cardinality: rare (only when send actually stalls)

## Existing Telemetry Fields Extended

### `wsErrorReason` enum (in transport-ws WS observer state)

- New value: `ws_send_timeout`
- Existing values preserved: `first_frame_timeout`, `mid_stream_stall`, `WS closed before response`, etc.
- Consumers: empty-turn-classifier, account rotation logic, runtime telemetry surfaces

### Empty-turn classifier transient set

- New transient reason: `ws_send_timeout`
- Recovery hint: `retry`
- Same routing as `first_frame_timeout`

## Metrics

This plan does not add any new metric. The existing transient-failure metric (counted by `wsErrorReason` value) absorbs `ws_send_timeout` automatically once the enum extends.

## Alerts (no new ones)

No alerts to add. Send-side stalls were previously invisible (silent connection hangs); they will now surface as transient failures and are absorbed by the existing alert thresholds for transient WS failures.

## What to Watch After Rollout

- **Δ in `ws_send_timeout` rate**: a non-zero baseline establishes after deploy; any spike correlates with network or backend-side issues
- **Δ in `cached_tokens` ratio in `[CODEX-WS] USAGE` lines**: should be unchanged or slightly improved (semantic alignment of `prompt_cache_key` with thread, not session)
- **Header parity**: `thread_id` should appear on every request post-deploy; absence indicates a code path that bypasses `buildHeaders()`
