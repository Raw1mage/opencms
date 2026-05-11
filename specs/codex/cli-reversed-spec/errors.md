# Errors — codex-cli reversed spec

This spec is a reference document, not a runtime component; it raises no errors of its own. The errors documented here are observed *in upstream codex-cli's runtime*, captured during the audit and referenced from the relevant chapters.

## Error Catalogue

| Error class | Upstream surface | Chapter |
|---|---|---|
| `CodexErr::Stream`, `CodexErr::RetryLimit` | HTTP/SSE retry exhaustion | Ch07 |
| WS reconnect with `RECONNECT_MAX_ATTEMPTS = 4` | WebSocket transport | Ch08 |
| `prompt_too_long` / 413 → compact-then-retry | Compact endpoint | Ch09 |
| `AttestationProvider` returning `None` → header suppressed | Telemetry | Ch12 |
| Rollout JSONL write failures → bus error | Rollout | Ch12 |

## Audit-time errors
None of the 144 claims required revision after re-anchor on the pinned SHA.
