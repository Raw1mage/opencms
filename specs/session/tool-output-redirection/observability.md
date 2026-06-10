# Observability — session_tool-output-redirection

## Events

| Event | When | Key payload |
|---|---|---|
| `tool.output.redirected` | a result is externalized | `tool`, `estimatedTokens`, `remainingWindowTokens`, `handle`, `previewTokens` |
| `tool.output.inline` | a result stays inline | `tool`, `estimatedTokens` (sampled/debug) |
| `tool.output.handle_resolved` | model fetches a handle | `handle`, `postCompaction:boolean` |
| `tool.output.handle_unresolved` | a fetch fails | `handle`, `reason` (retention/expired) — should be ~0 |

## Metrics

| Metric | Type | Purpose / alert |
|---|---|---|
| `tool.output.redirected_total{tool}` | counter | externalization volume by tool (spot the bloat sources, e.g. docxmcp) |
| `prompt.tool_bytes_inline_p95` → `prompt.tool_tokens_inline_p95` | histogram | inline tool-token contribution; must stay bounded after R3 |
| `compaction.cold_bgate_fired_total{provider}` | counter | **should drop sharply** once redirection bounds promptTotal (DD-6) — the cascade indicator |
| `tool.output.handle_unresolved_total` | counter | **must be ~0** — a redirected result that can't be fetched is data loss |
| `tool.output.refetch_per_redirect` | histogram | how often a redirect leads to a fetch — tunes the threshold (too high → over-redirecting) |

## RCA-ledger query path

"Why did this session's prompt balloon" = query `tool.output.redirected` +
`compaction.cold_bgate_fired` for the session: a spike of large inline tool tokens
without redirection (pre-fix) vs bounded handles (post-fix). The cold-B-gate firing
count is the direct before/after signal that the upstream fix worked.
