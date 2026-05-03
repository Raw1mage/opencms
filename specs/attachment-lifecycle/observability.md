# Observability: attachment-lifecycle

## Events

### Telemetry Events (DD-13)

All events go via `Bus.publish` or `log.info` (decide at impl time; both surfaced in daemon log file).

| Event | When | Payload |
|---|---|---|
| `attachment.dehydrated` | post-completion hook successfully dehydrates one image | `{ sessionID, filename, sha256, originalEstTokens, annotationChars }` |
| `attachment.dehydrate.skipped` | hook decides not to dehydrate | `{ sessionID, filename, reason: "non-image-mime" \| "failed-turn" \| "already-dehydrated" \| "dehydrate-disabled" \| "binary-missing-from-sqlite" }` |
| ~~`attachment.dehydrate.write_failed`~~ | (v1, SUPERSEDED 2026-05-04 — no writes) | — |
| `attachment.rereaded` | reread_attachment tool returns image bytes successfully | `{ sessionID, filename, byte_size }` |
| ~~`attachment.reread.expired`~~ | (v1, SUPERSEDED 2026-05-04 — folded into not_found) | — |
| `attachment.reread.not_found` | tool returns attachment_not_found error | `{ sessionID, filename, reason: "no-matching-part" \| "invalid-filename" \| "file-removed-from-repo" }` |
| ~~`attachment.gc.*`~~ | (v1, SUPERSEDED 2026-05-04 — no GC under DD-4') | — |

## Metrics

Derived counters / aggregates:

| Metric | Definition | Target |
|---|---|---|
| `attachment_dehydration_rate` | `count(attachment.dehydrated) / count(images_uploaded)` per session | ≥ 90% (most images get dehydrated; failed turns + already-dehydrated drop us below 100%) |
| `attachment_token_savings` | `sum(originalEstTokens - annotationChars/4) per session` | observe — hard target hard to set without baseline |
| `reread_rate` | `count(attachment.rereaded) / count(attachment.dehydrated)` | < 20% (most dehydrations should NOT need reread; if higher, annotation quality may be poor) |
| `reread_not_found_rate` | `count(attachment.reread.not_found) / count(attachment.rereaded + attachment.reread.not_found)` | < 10% (file-removed-from-repo is user-driven and not bounded; no-matching-part / invalid-filename should be < 1%) |
| ~~`gc_bytes_freed_per_day`~~ | (v1, SUPERSEDED 2026-05-04 — no GC) | — |
| ~~`incoming_dir_size_bytes`~~ | (v1, SUPERSEDED 2026-05-04 — repo-incoming owns) | — |
| ~~`dehydrate_write_failed_rate`~~ | (v1, SUPERSEDED 2026-05-04 — no writes) | — |

## Logs

Structured log via `Log.create({ service })`:

- `service: "attachment-lifecycle"` — main lifecycle events
- `service: "incoming-store"` — filesystem operations
- `service: "attachment-gc"` — GC sweep details

## Dashboards (suggested)

| Panel | Source | Period |
|---|---|---|
| Dehydration count per day | `attachment.dehydrated` | 7d, 30d |
| Token savings cumulative | derived from `attachment.dehydrated` payload | 30d |
| Reread rate | `attachment.rereaded` / `attachment.dehydrated` | 7d |
| Disk usage trend `~/.local/state/opencode/incoming/` | filesystem du sample | 30d |
| GC sweep duration + bytes freed | `attachment.gc.swept` | 30d |
| Top sessions by dehydration count | `attachment.dehydrated` group by sessionID | 7d |

## Alerts

| Alert | Condition | Action |
|---|---|---|
| ~~dehydration write failed~~ | (v1, SUPERSEDED 2026-05-04 — no writes from this spec) | — |
| reread not_found spike (no-matching-part) | `reason=no-matching-part > 5%` over 24h | review tool description; model may be confused about filename format |
| ~~incoming dir grew > 5GB~~ | (v1, SUPERSEDED 2026-05-04 — owned by repo-incoming-attachments) | — |
| ~~GC sweep duration~~ | (v1, SUPERSEDED 2026-05-04 — no GC) | — |
| dehydration rate < 50% for active session | derived | investigate why hook not firing (config? finish reason? all attachments lack repo_path = legacy session?) |

## Manual smoke checks

```bash
# Watch dehydration in real time
tail -f /run/user/1000/opencode-per-user-daemon.log | grep -E "attachment\.(dehydrated|reread|gc)"

# Spot-check incoming dir
du -sh ~/.local/state/opencode/incoming/
ls ~/.local/state/opencode/incoming/

# Verify a specific session's incoming
ls -la ~/.local/state/opencode/incoming/<sessionID>/
```

## Backwards compat observability

Old sessions (with hydrated attachments) emit no `attachment.dehydrated` events. They continue to send full image binaries on every turn — token usage will not benefit. This is by design (no migration; forward-only).

Operator can verify: `attachment_dehydration_rate` per session ID — old sessions = 0%, new sessions = ~90%+.
