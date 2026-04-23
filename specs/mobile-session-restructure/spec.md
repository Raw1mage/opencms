# Spec: mobile-session-restructure

## Purpose

Delete the duplicated file-body storage from session records — both
on disk and on wire — and delete the diff-viewing UI that depended
on it. The user never uses the diff viewer, so the simplest fix is
removal, not migration to a leaner viewer. The daemon's per-turn git
snapshot remains the authoritative source; power users can use
`git log` / `git show` directly if they ever want to inspect what
the AI did.

Stripping resolves mobile's white-flash / slow-entry / scroll-up
symptoms simultaneously and reclaims roughly 90 % of the 6.2 GB
currently occupied by session storage.

---

## Requirements

### Requirement: File-diff type drops before / after (R1)

#### Scenario: Persisted form is metadata-only

- **GIVEN** the assistant finishes a turn that modified files
- **WHEN** the user message's record is written to disk
- **THEN** each entry under `summary.diffs` contains only: file
  path, additions count, deletions count, and optional status
  (`added` / `deleted` / `modified`)
- **AND** no field anywhere in the record contains file body text
- **AND** the compiled type system forbids referencing before /
  after fields on the public file-diff type

#### Scenario: No transient full-shape

- **GIVEN** the diff-generation path runs at end of turn
- **WHEN** it computes addition / deletion counts per file
- **THEN** it does so by invoking git (same machinery already used
  for snapshots), never by materialising file bodies into its own
  memory buffers

---

### Requirement: Wire payload is metadata-only (R2)

#### Scenario: HTTP / SSE / share payloads

- **GIVEN** any server-to-client serialization — HTTP message-read
  route, `bus.message.updated` SSE event, share service export
- **WHEN** it emits a user message
- **THEN** each `summary.diffs[]` entry carries only the metadata
  fields
- **AND** response size per message scales with file count, not
  with cumulative file size

---

### Requirement: No diff-viewer UI (R3)

#### Scenario: Desktop review tab renders metadata only

- **GIVEN** a desktop user opens the review tab for a session
- **WHEN** the tab renders
- **THEN** each file shows as one row: path, additions, deletions,
  status
- **AND** there is no expand button, no modal, no lazy-load path
- **AND** no network request for file contents is issued

#### Scenario: Enterprise share page likewise

- **GIVEN** a public share page rendering a shared session
- **THEN** file changes appear as metadata-only rows
- **AND** users who want actual diff content are expected to check
  git directly (noted in release notes)

#### Scenario: Mobile — same

- **GIVEN** the mobile session UI
- **THEN** diffs render as metadata rows only
- **AND** no interaction path opens anything heavier

---

### Requirement: Server-side owned-diff reads git directly (R4)

#### Scenario: Workspace owned-diff check still works

- **GIVEN** a session with file modifications
- **WHEN** the workspace owned-diff check runs (existing flow
  determining which diffs fall under workspace ownership)
- **THEN** it obtains the file-content comparisons it needs by
  querying git against the per-message snapshot commit
- **AND** its final output matches the pre-migration output
  bit-for-bit for the same file set

#### Scenario: Git failure is surfaced, not swallowed

- **GIVEN** the git invocation fails (corrupted snapshot, repo
  lock, disk full)
- **WHEN** owned-diff tries to derive a needed comparison
- **THEN** the caller receives an explicit error
- **AND** owned-diff does not return empty or partial state as
  if the file had no changes

---

### Requirement: Historical sessions migrated in place (R5)

#### Scenario: Run migration on an untouched storage directory

- **GIVEN** `~/.local/share/opencode/storage/session/` populated
  with legacy records
- **AND** the operator has captured a backup via `cp -a`
- **WHEN** the migration script runs
- **THEN** every message record is rewritten to the slim shape
  atomically (temp-write + rename)
- **AND** a migration marker is written per session
- **AND** total disk usage in `session/` drops ≥ 85 %
- **AND** no message loses its addition / deletion metadata

#### Scenario: Migration interrupted

- **GIVEN** the migration script is killed mid-run
- **WHEN** the operator restarts it
- **THEN** sessions already marked as migrated are skipped
- **AND** a session whose per-file rewrites were half-done
  resumes cleanly (atomic renames mean no file is partially
  written; remaining files just get rewritten)

#### Scenario: Migration handles malformed records gracefully

- **GIVEN** a message info.json that fails to parse
- **WHEN** the script encounters it
- **THEN** the script logs a warning identifying the file and
  continues with the next message in the session
- **AND** the session's marker is NOT written (so a later re-run
  can retry)

---

### Requirement: Observable outcome (R6)

#### Scenario: Disk reclamation

- **GIVEN** the current `session/` dir measured at 6.2 GB pre-spec
- **WHEN** the migration script completes on this machine
- **THEN** `du -sh session/` reports ≤ 1 GB

#### Scenario: Mobile session entry time

- **GIVEN** a large (pre-migration equivalent) session
- **WHEN** the user opens it after this spec ships
- **THEN** first paint of the conversation tail occurs within
  2 seconds on a typical mobile connection
- **AND** no visible white flash accompanies subsequent user
  messages

---

## Acceptance Checks

A1. **Disk reclamation**: `du -sh` on `session/` drops from 6.2 GB
    to ≤ 1 GB post-migration.

A2. **No before/after in code**: grep the codebase — no reference
    to `diff.before` / `diff.after` / `summary.diffs[i].before`
    / `summary.diffs[i].after` remains on any path that touches
    persisted records, wire payloads, or UI render. The type
    itself no longer declares those fields.

A3. **Owned-diff parity**: run the workspace owned-diff check on
    three sessions pre- and post-migration; outputs match for
    every file.

A4. **Wire size shrinkage**: fetch one previously-problematic
    message (pre-migration it was ~4.5 MB on wire); post-migration
    it is under 10 KB.

A5. **Migration idempotency**: run the script twice; the second
    run reports zero rewrites and produces identical on-disk
    state.

A6. **UI rendering**: open the review tab on a migrated session;
    it shows metadata rows only, no expand control present,
    zero network requests for diff contents.

A7. **Mobile visual**: on a real mobile client, open the
    previously-problematic session; first paint ≤ 2 s; no white
    flash on 3 successive user inputs.
