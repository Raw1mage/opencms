# Compliance Map

| Requirement | Control |
| --- | --- |
| Prevent cross-user notification leakage | Explicit toast scope and no silent global fallback. |
| Prevent stale UI notification display | Required `emittedAt`/`ttlMs` and frontend drop gate. |
| Preserve auditability | Existing TOAST-TRACE logs include publish, SSE write, receive/drop evidence. |
