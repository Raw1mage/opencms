# Observability: mobile-session-restructure

## Events

Bus events touched by this spec are unchanged in identity:
`bus.message.updated` still fires, `bus.session.updated` still
fires. Only their payloads shrink (no new event type).

New lightweight structured log events are emitted by:

- **Migration script** (one-shot; logs go to stderr + debug.log):
  - `migration.diff_strip.session_start` — per session begin
  - `migration.diff_strip.message_processed` — per message rewritten
  - `migration.diff_strip.session_done` — per session with
    audit payload
  - `migration.diff_strip.session_skipped` — per session where
    marker was already present
  - `migration.diff_strip.malformed_info` — per malformed
    info.json skipped
  - `migration.diff_strip.summary` — one final line at end

- **Owned-diff reader**:
  - `owned_diff.git_error` — when git invocation fails

## Metrics

- `migration.diff_strip.sessions_processed` — counter (final
  value reported at script end)
- `migration.diff_strip.sessions_skipped` — counter
- `migration.diff_strip.messages_touched` — counter
- `migration.diff_strip.bytes_reclaimed` — counter (sum of
  `(old_info_size - new_info_size)` per rewritten message)
- `migration.diff_strip.malformed_info_count` — counter
- `owned_diff.git_error` — counter (labels: `outcome` ∈
  `bad_ref` / `repo_lock` / `other`)

## Logs

- Log-level usage:
  - `info` for migration progress (session_start, session_done,
    summary)
  - `warn` for recoverable skips (session_skipped,
    malformed_info)
  - `error` for explicit failures (MIGRATION_WRITE_FAILED,
    OWNED_DIFF_GIT_UNAVAILABLE)
- Required structured fields:
  - migration: `service: "diff-migration"`, `sessionID`,
    `messageCount`, `bytesReclaimed`
  - owned-diff: `service: "owned-diff"`, `sessionID`, `file`,
    `gitRef`

## Alerts

- `migration-malformed-spike` — fires when
  `migration.diff_strip.malformed_info_count` > 10 during a single
  run
  - **Action**: operator reviews listed paths; may need to
    hand-patch or restore from backup
- `owned-diff-git-error-rate` — fires when
  `owned_diff.git_error` > 5 per hour post-deploy
  - **Action**: investigate git repo health; possible snapshot
    corruption or disk pressure

## Dashboards

No new dashboards introduced. The migration is a one-shot run;
its output is captured in event-log form. Owned-diff error
counter is added to the existing provider-health dashboard when
convenient (not blocking).

## Success metric

After migration + daemon restart, the single measurable success
indicator is:

- `du -sh ~/.local/share/opencode/storage/session/` drops from
  ~6.2 GB to ≤ 1 GB (≥ 80 % reduction).

This is manually verified per tasks.md 7.1 / 8.4, not a
continuously-monitored metric.
