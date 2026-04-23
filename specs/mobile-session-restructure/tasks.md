# Tasks: mobile-session-restructure

Phased execution checklist. Each task ID maps to an IDEF0 activity
(A1..A6) or cross-cut concern.

---

## 1. Schema: drop before/after from the one canonical type

- [ ] 1.1 Edit [packages/opencode/src/snapshot/index.ts](packages/opencode/src/snapshot/index.ts):
  remove `before` and `after` fields from `FileDiff` zod schema;
  keep `file`, `additions`, `deletions`, optional `status`.
- [ ] 1.2 Verify `Snapshot.FileDiff` type no longer references
  before/after; `tsc --noEmit` forces compile errors at every
  current reader — those errors drive the Phase 2-4 edits.
- [ ] 1.3 `grep -rn "diff\\.before\\|diff\\.after\\|summary\\.diffs.*before\\|summary\\.diffs.*after" packages/` produces zero matches in source (test files excluded).

## 2. Diff generator: emit metadata only (A1/A2)

- [ ] 2.1 Edit the diff computation path in
  [packages/opencode/src/snapshot/index.ts](packages/opencode/src/snapshot/index.ts)
  `diffFull` (and any sibling functions):
  - Switch from `git diff` with body extraction to `git diff --numstat`
    + `git diff --name-status` to obtain counts + status without
    reading file bodies into memory.
  - Emit `FileDiff` entries with metadata only.
- [ ] 2.2 Audit all callers of `diffFull` / `FileDiff` producers
  (workflow-runner.ts, any session-diff generator):
  verify nobody allocates file-body strings that are never
  consumed.

## 3. Owned-diff reader: call git directly (A4)

- [ ] 3.1 Edit [packages/opencode/src/project/workspace/owned-diff.ts](packages/opencode/src/project/workspace/owned-diff.ts):
  replace the four `diff.before` / `diff.after` references (lines
  70–71, 133–134) with inline `git show <snapshotCommit>:<file>`
  calls.
- [ ] 3.2 Surface git invocation errors explicitly — throw a
  named error (`OwnedDiffGitUnavailable`), do not return empty or
  partial state.
- [ ] 3.3 Unit-style verify: against a small fixture session
  directory, owned-diff output matches pre-change behaviour
  byte-for-byte.

## 4. UI: metadata-only render (A6)

- [ ] 4.1 Edit [packages/app/src/pages/session/review-tab.tsx](packages/app/src/pages/session/review-tab.tsx):
  delete expand/diff-pane code paths; render one row per changed
  file with path, additions, deletions, status.
- [ ] 4.2 Edit [packages/ui/src/components/session-review.tsx](packages/ui/src/components/session-review.tsx):
  same simplification in the shared component.
- [ ] 4.3 Edit [packages/enterprise/src/routes/share/[shareID].tsx](packages/enterprise/src/routes/share/[shareID].tsx):
  render metadata-only share view; remove references to
  `diff.before` / `diff.after`.
- [ ] 4.4 Verify no UI component or hook still tries to read
  before/after (type system makes this mechanical).
- [ ] 4.5 Mobile responsive check: on narrow viewport, rows render
  without horizontal scroll.

## 5. Migration script (A5)

- [ ] 5.1 New file
  `packages/opencode/src/cli/cmd/maintenance/migrate-strip-diffs.ts`:
  CLI with `--dry-run`, `--session <sid>`, `--verbose` flags.
- [ ] 5.2 Logic: walk `Global.Path.data/storage/session/`; per
  session check marker; per message read info.json, strip
  `before`/`after` from `summary.diffs[]`, write temp+rename.
- [ ] 5.3 Per-session atomicity: at the end of a session's rewrite,
  write the marker last. If script crashes mid-session, marker
  absent → re-run reprocesses the session.
- [ ] 5.4 Malformed info.json handling: log + skip message (not
  session); mark session done only if ALL messages processed
  cleanly. If any message skipped, marker is withheld so operator
  can re-run once fixed.
- [ ] 5.5 Emit counters: sessions processed, messages touched,
  bytes reclaimed. Final line printed to stdout + telemetry
  event.
- [ ] 5.6 `--dry-run` mode reports would-change counts without
  writing anything.

## 6. Release notes + docs

- [ ] 6.1 Add entry to release notes: wire format change for
  session message reads; diff viewer feature removed; enterprise
  share consumers depending on inline before/after must migrate
  (pointer: use git directly against the user's snapshot repo).
- [ ] 6.2 Update `specs/architecture.md` with a short section
  pointing to this spec after it reaches `living`.

## 7. Validation

- [ ] 7.1 A1 disk reclamation — after migration on this machine:
  `du -sh storage/session/` drops from 6.2 GB to ≤ 1 GB.
- [ ] 7.2 A2 code audit — zero references to `diff.before` /
  `diff.after` remain in source (excluding migration script which
  must read them transiently).
- [ ] 7.3 A3 owned-diff parity — three sessions, output matches
  pre-migration bit-for-bit.
- [ ] 7.4 A4 wire size — message fetch for previously
  problematic session drops from ~4.5 MB to < 10 KB.
- [ ] 7.5 A5 migration idempotency — second run zero rewrites.
- [ ] 7.6 A6 UI — review tab renders metadata rows only; no
  network request for diff contents.
- [ ] 7.7 A7 mobile — session entry < 2 s; no white flash on 3
  user inputs.

## 8. Rollout

- [ ] 8.1 Operator takes backup: `cp -a ~/.local/share/opencode/storage/session/ ~/.local/share/opencode/storage/session.bak-<date>/`
- [ ] 8.2 Daemon restart via restart_self (code changes picked up).
- [ ] 8.3 Operator runs migration script in `--dry-run` first,
  inspects output, then runs for real.
- [ ] 8.4 Verify acceptance A1-A7 on this machine.
- [ ] 8.5 Promote spec planned → implementing → verified → living
  via plan-promote.
- [ ] 8.6 Update architecture.md and commit.
- [ ] 8.7 Delete disposable beta/test branches after merge.
