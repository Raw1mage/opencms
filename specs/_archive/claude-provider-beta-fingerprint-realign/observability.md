# Observability: claude-provider-beta-fingerprint-realign

## Events

This refactor emits no new runtime events. The wire-fingerprint change is observable via existing channels:

| Event | Source | What changes |
|---|---|---|
| Outgoing HTTP request `anthropic-beta` header value | `packages/provider-claude/src/headers.ts` `buildHeaders()` | Order + content of the comma-joined string changes for every request after deploy |
| Token-refresh event | unchanged | Unaffected by this plan |
| SSE stream parse events | unchanged | Unaffected (the SSE parser is in `sse.ts`, not touched) |

## Metrics

No new metrics. Existing metrics relevant to this change:

| Metric | Where | Pre-deploy baseline | Post-deploy expected |
|---|---|---|---|
| Anthropic `4xx` rate per provider account | gateway access log | Currently low; some `400 invalid beta` may be hidden in noise | Should not increase; if it does, **STOP-1** is triggered |
| Cache hit rate (`cache_read_input_tokens / input_tokens`) | Anthropic SSE `usage` block | Unchanged baseline | Unchanged — `prompt-caching-scope-2026-01-05` is still emitted under opencode's typical conditions (firstParty + experimental enabled), so caching behavior is preserved |
| `context-management` activation rate | Anthropic response shape (presence of context-management responses) | Always-on (we send unconditionally pre-realign) | Conditional on `iO_` predicate; only changes for non-supported models — but opencode only uses claude-opus-4-*, claude-sonnet-4-*, claude-haiku-4-* which all pass the predicate, so no observable shift |
| `redact-thinking` engagement | thinking block content shape | n/a (we never send the flag pre-realign) | Still effectively n/a in opencode (DD-17: `isInteractive=false` always); engagement only in tests |

## Log signals to watch on deploy

These are not new log lines — they are existing lines whose content will shift:

- `[claude-provider] doStream` — Pre-realign, every request log shows the same beta string. Post-realign, the string differs by `(model × env)` combination. Diff a captured request before/after to confirm parity-vs-upstream rather than parity-vs-old-self.
- `[claude-provider] auth refresh` — Unchanged; if it suddenly fails post-deploy, the OAuth-only constraint (DD-16) is being violated by a regression elsewhere.

## Rollback signal

If post-deploy any of the following happen, revert the commit:

1. `400 invalid_beta_param` errors appear in gateway log within 1 hour of deploy
2. Cache hit rate drops by more than 20% on a 1-hour window
3. opencode requests start succeeding with API-key auth (would mean DD-16 was violated; immediate concern)

Rollback is `git revert <commit>` on `main`; no migration is needed because the change is wire-only and stateless.
