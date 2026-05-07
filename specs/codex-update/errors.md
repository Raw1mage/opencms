# Errors: codex-update

This plan introduces **one** new error path. All other failures continue through the existing classifier and surface to opencode core unchanged.

## Error Catalogue

### New Errors

### `ws_send_timeout`

| Field | Value |
|---|---|
| Layer | provider transport (`transport-ws.ts`) |
| Trigger | `ws.send(...)` callback does not fire within `WS_IDLE_TIMEOUT_MS` (30s) |
| User-visible message | (none — internal; surfaces via existing empty-turn classifier as a transient failure) |
| Recovery | retry (handled by existing rotation / continuation flow) |
| Telemetry | `wsErrorReason = "ws_send_timeout"` recorded in WS observer state and propagated to empty-turn-classifier |
| Classification | transient (same category as `first_frame_timeout`, `mid_stream_stall`) |
| Source | upstream codex commit `35aaa5d9fc` (#20751) |

## Unchanged Errors

The following error paths exist already and are NOT modified by this plan:

- `first_frame_timeout` — receive-side first-frame stall (transient, retry)
- `mid_stream_stall` — receive-side mid-stream silence (transient, retry)
- `WS closed before response` — server-initiated close before any frame (transient)
- All HTTP status-coded errors (401 rotation, 429 rate, 5xx) — unchanged path
- All provider-level validation errors (missing account, expired token) — unchanged path

## Errors NOT Introduced (by design)

- No error for missing `thread_id` — defaults to `sessionId` per DD-1
- No error for `response.processed` ack failure — feature deferred per DD-5
- No error for compact-direct-call failures — out of scope per DD-4
