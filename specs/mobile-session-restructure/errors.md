# Errors: mobile-session-restructure

## Error Catalogue

### Owned-diff reader

- **OWNED_DIFF_GIT_UNAVAILABLE** — git invocation failed while
  deriving file content for workspace owned-diff check
  - **Message**: "git show <ref>:<file> failed: <git stderr>"
  - **Trigger**: corrupted snapshot, repo lock, disk full, bad
    ref (deleted commit)
  - **Recovery**: caller receives explicit error; workspace
    integrity check surfaces the failure. Operator investigates
    git repo state; never silently skip the file.
  - **Layer**: project/workspace/owned-diff.ts

### Migration script

- **MIGRATION_INFO_JSON_MALFORMED** — a message's info.json
  cannot be parsed
  - **Message**: "malformed info.json at <path>: <parse error>"
  - **Trigger**: partial write from an old crash, disk
    corruption, wrong schema version from a future
  - **Recovery**: log + skip this message; do NOT mark the
    session's migration as done (the session retains its marker
    absent so re-run picks it up). Operator inspects the file
    manually.
  - **Layer**: cli/cmd/maintenance/migrate-strip-diffs.ts

- **MIGRATION_WRITE_FAILED** — atomic rewrite failed mid-session
  - **Message**: "failed to atomically rewrite <path>: <fs error>"
  - **Trigger**: disk full, permission change, filesystem full
  - **Recovery**: abort current session; leave marker absent;
    surface to operator. Other sessions continue. Partial temp
    files cleaned up on script exit.
  - **Layer**: cli/cmd/maintenance/migrate-strip-diffs.ts

### UI

No error codes added by this spec at the UI layer; UI has been
simplified to metadata-only and has no failure modes beyond the
existing session-read paths.

## Error Code Format

- `UPPER_SNAKE_CASE`, domain-prefixed: `OWNED_DIFF_*`,
  `MIGRATION_*`.
- Codes are stable; messages may evolve.

## Recovery Strategies

Three patterns:

1. **Structured error to caller** — used by OWNED_DIFF_GIT_UNAVAILABLE.
   The owned-diff consumer decides: abort the higher-level integrity
   check, surface to the user, or retry after operator fixes git
   state.
2. **Log + skip at per-message granularity, withhold session marker** —
   used by MIGRATION_INFO_JSON_MALFORMED. The session stays
   unmigrated so operator can re-run after fixing the file.
3. **Abort session, clean temp files** — used by MIGRATION_WRITE_FAILED.
   Other sessions unaffected.

No error in this spec silently degrades. Every failure surfaces
explicitly per AGENTS.md rule 1 "no silent fallback".
