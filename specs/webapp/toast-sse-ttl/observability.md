# Observability

## Events

| Signal | Location | Purpose |
| --- | --- | --- |
| `[TOAST-TRACE] sse-write` | backend global SSE route | Measure publish-to-SSE write latency and scope/TTL metadata. |
| `[TOAST-TRACE] recv` | frontend GlobalSync | Measure publish-to-browser latency for fresh toasts. |
| `[TOAST-TRACE] dropped` | frontend GlobalSync | Confirm TTL/malformed drops with age, ttl, title, and scope. |

## Metrics

| Metric | Source | Purpose |
| --- | --- | --- |
| `traversalMs` | `emittedAt` to frontend receive time | Detect delayed toast delivery. |
| `queuedMs` | `emittedAt` to SSE write time | Detect backend queueing before client delivery. |
| `dropped stale count` | frontend console trace aggregation | Confirm stale reconnect toasts are suppressed. |
