# Errors: compaction-improvements

## Error Catalogue

| Code                          | Layer            | Message                                                              | Recovery                                                                            |
| ----------------------------- | ---------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| E_COMPACTION_NO_USER_BOUNDARY | prompt runloop   | Cannot compact because no completed user message is available.       | Do not spawn compaction child; continue with explicit telemetry.                    |
| E_COMPACTION_LOOP_GUARD       | compaction       | Compaction skipped inside compaction child runloop.                  | Return stop/continue according to existing run outcome; do not recursively compact. |
| E_ATTACHMENT_REF_STORE_FAILED | boundary storage | Cannot process attachment because session storage failed.            | Reject the boundary content with explicit reason.                                   |
| E_WORKER_QUERY_FAILED         | worker tools     | Worker query failed for stored reference.                            | Return explicit tool error; raw content remains out of main context.                |
| E_CODEX_MODE1_UNSUPPORTED     | codex provider   | Codex inline context management is unavailable on this request path. | Disable only the explicit Mode 1 attempt and continue with visible event evidence.  |
