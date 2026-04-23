# Design: mobile-session-restructure

## Context

File-diff records under user-message `summary.diffs[]` currently
store full before / after file bodies alongside metadata. Upstream
added this field one day after introducing the diff API. On this
machine the duplication accounts for ~90 % of 6.2 GB session
storage and explains the 2026-04-23 mobile-UX collapse.

The user does not use the diff-viewing UI. There is no business
case to spend effort preserving it. This spec deletes the feature
outright: storage is slimmed, the UI stops rendering expanded
diffs, the server needs no on-demand endpoint. Anyone who really
needs to see what the AI did can run `git log` / `git show`
against the snapshot repo manually.

This is the simplest possible fix: remove the thing that was
wrong, don't build any infrastructure to simulate its absence.

## Goals / Non-Goals

### Goals

- Remove every in-code reference to `before` / `after` on the
  file-diff type, on disk and on wire.
- Reclaim ~5.5 GB of duplicated storage on this machine via a
  one-shot migration.
- Server-side workspace owned-diff check keeps working by asking
  git directly.
- Mobile / desktop clients receive only metadata and render one
  line per changed file.

### Non-Goals

- Preserve a client-visible diff viewer in any form. No expand
  button, no diff route, no lazy-load flow.
- Invent a session-updated delta protocol (original v1 hypothesis
  — dropped).
- Change git snapshot management / retention.
- Restrict client-to-server file uploads.
- I-1 status bar hydration (separate spec).
- Backwards compatibility with external share-page consumers that
  expected inline diff bodies; release notes document the break.

## Decisions

### DD-1 — Schema: metadata only

The public file-diff type has these fields only:

```ts
FileDiff {
  file: string,
  additions: number,
  deletions: number,
  status?: "added" | "deleted" | "modified",
}
```

`before` and `after` are removed outright. No `snapshotRef` or
`priorSnapshotRef` either — since no client endpoint reconstructs
diffs, the server doesn't need to record the commit references on
each entry; the existing per-message `snapshot` commit hash
(already recorded elsewhere in the message info) is enough for
the one internal consumer (owned-diff, DD-3).

### DD-2 — Diff generator never computes before / after

End-of-turn diff generation queries git for addition / deletion
counts (`git diff --numstat` + status) and emits the slim entries
directly. No file bodies are read into memory buffers.

### DD-3 — Owned-diff check reads git directly

Workspace owned-diff is the one server-side consumer that
currently uses before / after. It's refactored to read file
contents from git (against the message's existing snapshot
commit + its parent) when it genuinely needs to compare. No
shared "derive helper" library — the owned-diff module calls
git inline. Keeping it co-located with its one caller is simpler
than extracting a util.

### DD-4 — No on-demand HTTP route

No new server endpoint. Clients that want to inspect old-state /
new-state of files go to the snapshot git repo directly (its path
is stable; power users can already access it). Most users won't,
which is the whole point.

### DD-5 — UI renders metadata rows only

Desktop review tab, session-review shared component, and
enterprise share page all change to render one text row per
changed file: `foo.ts  +12 / -3  modified`. No expand button, no
click behaviour, no conditional fetch. Clean deletion of the
before/after rendering code.

The review-tab component and SessionReview component files stay
(they're useful as summary views) but their expand-diff panes are
deleted.

### DD-6 — Migration script: strip in place, atomic, idempotent

Maintenance script invoked manually:

```
bun run packages/opencode/src/cli/cmd/maintenance/migrate-strip-diffs.ts
```

Per session directory:

1. Read per-session migration marker at
   `<session>/.diff-migration-v1.done`. If present → skip.
2. For each `messages/*/info.json`:
   - Parse JSON.
   - If `summary.diffs[]` entries have `before` / `after`, drop
     them. Keep everything else.
   - Write to `<info>.tmp`, rename to `info.json` (atomic).
3. Write the migration marker with audit payload.
4. Log one-line summary per session: messages touched, bytes
   reclaimed.

Operator takes a `cp -a` backup before running. Script doesn't
auto-backup. Documented in handoff.md.

Script is idempotent: the marker skips completed sessions;
atomic per-file rename means crash-safe.

### DD-7 — No feature flag, no rollback path

The previous shape was a mistake. Rolling back would mean
re-introducing the mistake. Ship the new shape; if something
breaks, fix it forward.

### DD-8 — Failure modes

| Failure | Behaviour |
|---|---|
| Migration interrupted | Marker absent → re-run skips completed sessions |
| Malformed info.json | Script logs + skips that message, continues session |
| Git unavailable for owned-diff check | Owned-diff reports an explicit error to its caller; the workspace integrity check surfaces the failure rather than silently skipping |
| External share-page scraper wanted inline diffs | Breaks. Documented in release notes. |

### DD-9 — Observability

- `migration.diff_strip.sessions_processed` (counter)
- `migration.diff_strip.bytes_reclaimed` (counter; gauge at end)
- `owned_diff.git_error` (counter; was this path hit?)

## Risks / Trade-offs

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Owned-diff semantics break when switching from inline-body comparison to git-based comparison | Same snapshot commits are being compared; semantics preserved. A3 test compares before/after outputs on fixture sessions |
| R2 | Migration corrupts a session file | Operator backup + atomic per-file rename + idempotency marker |
| R3 | Hidden reader of before/after not caught by grep | Type-level removal forces compile error on any remaining reader |
| R4 | Enterprise share-page scraper breaks | Release notes document the break; users who need diffs go to git |
| R5 | Migration takes too long (2545 sessions) | Per-session work is small (JSON parse + strip + rewrite); estimate minutes, not hours; script can run in background |

## Critical Files

### Direct edits

- [packages/opencode/src/snapshot/index.ts](packages/opencode/src/snapshot/index.ts) — drop before/after from FileDiff zod schema; refactor `diffFull` to produce metadata only
- [packages/opencode/src/session/workflow-runner.ts](packages/opencode/src/session/workflow-runner.ts) — diff generator at turn boundary produces slim entries
- [packages/opencode/src/project/workspace/owned-diff.ts](packages/opencode/src/project/workspace/owned-diff.ts) — owned-diff reader calls git directly for needed content
- [packages/app/src/pages/session/review-tab.tsx](packages/app/src/pages/session/review-tab.tsx) — render one metadata row per file; delete expand pane
- [packages/ui/src/components/session-review.tsx](packages/ui/src/components/session-review.tsx) — same simplification
- [packages/enterprise/src/routes/share/[shareID].tsx](packages/enterprise/src/routes/share/[shareID].tsx) — render metadata-only share view

### New files

- `packages/opencode/src/cli/cmd/maintenance/migrate-strip-diffs.ts` — migration script

### Deleted / simplified

- Any helper / cache / expand-pane code in the three UI files above
- No new server routes; no shared derive helper

### Prompt updates

None.

### Modeling artifacts

- `specs/mobile-session-restructure/idef0.json` — activities: Generate-slim / Persist / Read-metadata / Owned-diff-derive / Migrate (5, no on-demand route)
- `specs/mobile-session-restructure/grafcet.json` — simplified: no expand state machine
- `specs/mobile-session-restructure/c4.json` — trimmed: no on-demand route component, no shared derive helper
- `specs/mobile-session-restructure/sequence.json` — happy path / owned-diff / migration (3 scenarios, no UI-expand scenarios)

## Open Questions

(none — resolved during proposal phase)
