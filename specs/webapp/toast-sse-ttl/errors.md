# Errors

## Error Catalogue

| Code | Condition | Handling |
| --- | --- | --- |
| `TOAST_STALE` | `Date.now() - emittedAt > ttlMs` | Drop frontend display and log trace. |
| `TOAST_MISSING_FRESHNESS` | Missing/invalid `emittedAt` or `ttlMs` | Drop frontend display and log trace. |
| `TOAST_INVALID_SCOPE` | Scope outside allowed enum | Backend schema/test failure; frontend also drops if observed. |
