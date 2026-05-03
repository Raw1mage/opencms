# Spec: docx-upload-autodecompose

## Purpose

Define the behavioral contract for the upload-time auto-decompose
pipeline that turns Office attachments into ready-to-read directory
trees before the AI sees the user message. This spec is the single
source of truth for what the system must do; design.md records why
and how, this file records what behaviour is required.

## Requirements

### Requirement: Fast-phase decompose runs synchronously at upload time

> **Amended 2026-05-03 (during phase 1):** the original "fully
> synchronous" wording was wrong for very large docx. The contract
> is now two-phase per DD-1 + DD-11. See the next requirement for
> the background phase.

#### Scenario: docx upload's fast phase completes before the AI sees the message

- **GIVEN** a user uploads a .docx file with mime
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- **AND** no prior `incoming/<stem>/` directory exists for this filename
- **WHEN** the upload arrives at the upload dispatcher
- **THEN** the dispatcher calls docxmcp's `extract_all` entry with
  the file's repo-relative path
- **AND** waits for the fast phase to return (synchronous, < 30 s)
- **AND** writes the returned outline + template + manifest to
  `incoming/<stem>/`
- **AND** writes `_PENDING.md` markers in `chapters/`, `tables/`,
  `media/` before forwarding
- **AND** only then forwards the user message to the AI

### Requirement: Background phase produces body + chapters + tables + media

#### Scenario: background phase completes asynchronously after the fast phase

- **GIVEN** the fast phase has returned with manifest's
  `decompose.background_status = "running"` and
  `pending_kinds = ["body", "chapter", "table", "media"]`
- **WHEN** the docxmcp-side detached child process runs to completion
- **THEN** `body.md` is written under `incoming/<stem>/`
- **AND** `chapters/*.md`, `tables/*.csv`, `media/*` are populated
- **AND** the manifest is rewritten with `background_status = "done"`,
  `pending_kinds` removed, `background_duration_ms` recorded, and
  the new files appended to the `files` array
- **AND** the `_PENDING.md` markers are removed from each pending
  subdirectory

#### Scenario: AI can discover the running state without prior knowledge

- **GIVEN** the fast phase has returned and background is still running
- **WHEN** the AI does `ls incoming/<stem>/chapters/`
- **THEN** the AI sees a `_PENDING.md` file
- **AND** that file's contents instruct the AI to read
  `manifest.json`'s `decompose.background_status` and to call
  `mcpapp-docxmcp_extract_all_collect` if it needs to wait

#### Scenario: AI can synchronously wait for completion when needed

- **GIVEN** the AI needs `body.md` or `chapters/*` and finds them missing
- **AND** `manifest.json`'s `decompose.background_status = "running"`
- **WHEN** the AI calls `mcpapp-docxmcp_extract_all_collect` with
  the same `doc_dir`
- **THEN** the call blocks up to 60 s waiting for completion
- **AND** returns the updated manifest with the full file list

#### Scenario: dispatcher polls incrementally so the host mirrors the container in near-real-time

- **GIVEN** the fast phase returned with `background_status = "running"`
- **WHEN** the dispatcher's poll timer fires (every 5 s)
- **THEN** the dispatcher calls `extract_all_collect` with `wait=0`
- **AND** the docxmcp-side bundle producer ships any files written
  by the background phase since the last bundle for this token
- **AND** the dispatcher publishes them into the same
  `incoming/<stem>/` tree (overwrites manifest, removes obsolete
  `_PENDING.md` markers)
- **AND** the dispatcher continues polling until the returned
  manifest's `background_status != "running"` OR a safety cap
  (180 s) is reached
- **AND** the AI's next turn sees a tree that grows progressively
  as background produces files (not a single batch at the end)

#### Scenario: each polling cycle ships only files new since the previous bundle

- **GIVEN** the bundle producer maintains a per-token
  `_last_bundled_state` snapshot
- **WHEN** consecutive `extract_all_collect` calls happen against
  the same token
- **THEN** each call's bundle contains only files added or modified
  since the previous call's bundle (no duplicates, no gaps)
- **AND** a polling cycle that finds no new files ships an empty
  bundle (and an unchanged manifest)

#### Scenario: background phase failure is recorded loudly

- **GIVEN** the background phase throws an exception
- **WHEN** the exception is caught by the detached child
- **THEN** the manifest is rewritten with
  `background_status = "failed"` and a one-line `background_error`
- **AND** `_PENDING.md` markers are NOT removed (signal that
  something went wrong)
- **AND** the dispatcher's scheduled collect call surfaces this state
  to the AI on the next routing-hint refresh

### Requirement: Cache hit short-circuits decompose (success and failure both cache)

#### Scenario: identical re-upload of a previously-successful decompose skips decompose

- **GIVEN** a prior `incoming/<stem>/manifest.json` exists with
  `decompose.status = "ok"`
- **AND** its `source.sha256` matches the new upload's sha256
- **AND** its `source.filename` matches the new upload's filename
- **WHEN** the upload arrives
- **THEN** the upload hook does not call docxmcp
- **AND** the existing manifest is reused
- **AND** the routing hint marks the result as a cache hit

#### Scenario: identical re-upload of a previously-failed decompose returns the cached failure (per DD-12)

- **GIVEN** a prior `incoming/<stem>/manifest.json` exists with
  `decompose.status = "failed"` and a `decompose.reason`
- **AND** its `source.sha256` + `source.filename` match the new upload
- **WHEN** the upload arrives
- **THEN** the upload hook does NOT re-attempt decompose
- **AND** the cached failure manifest is reused
- **AND** the routing hint surfaces the cached-failure state with
  `**過去拆解曾失敗**` prefix and explains both retry paths
  (modify file content; or `rm -rf incoming/<stem>/`)

### Requirement: Same-name different-content uploads paired-rename the OLD version aside

#### Scenario: sha drift triggers paired version-rename

- **GIVEN** a prior `incoming/foo.docx` and `incoming/foo/` exist
- **AND** the prior manifest's `source.uploaded_at = "2026-05-03T08:14:22Z"`
- **AND** a new upload arrives with filename `foo.docx`
- **AND** the new upload's sha256 differs from the prior manifest's
- **WHEN** the upload-time hook in `tryLandInIncoming` processes it
- **THEN** **both** the old source file and the old bundle dir are
  renamed atomically with the suffix `-20260503-081422`:
  - `incoming/foo.docx` → `incoming/foo-20260503-081422.docx`
  - `incoming/foo/` → `incoming/foo-20260503-081422/`
- **AND** the new bytes are written to `incoming/foo.docx`
- **AND** a fresh decompose runs into `incoming/foo/`
- **AND** if either rename fails, both are rolled back and the new
  upload fails (loud, no half-state)
- **AND** the routing hint advertises only the canonical
  `incoming/foo.docx` + `incoming/foo/`, never the suffixed sibling

### Requirement: Decompose failure is soft

#### Scenario: docxmcp times out

- **GIVEN** docxmcp's `extract_all` does not respond within 30 s
- **WHEN** the dispatcher's deadline fires
- **THEN** the upload still succeeds (file remains at `incoming/foo.docx`)
- **AND** `incoming/foo/manifest.json` is written with
  `decompose.status = "failed"` and `decompose.reason` containing
  exactly one plain-language sentence
- **AND** `incoming/foo/failure.md` is written with the same reason
- **AND** the routing hint shown to the AI matches DD-6 wording
  (acknowledges failure, asks AI to handle without decomposed tree)
- **AND** the dispatcher does not silently retry; does not silently
  fall back to the AI-driven docxmcp path

### Requirement: Legacy Office uses in-process layout-preserving fallback

#### Scenario: .doc upload produces body.md preserving layout

- **GIVEN** a user uploads a .doc file with mime `application/msword`
- **WHEN** the dispatcher processes the upload
- **THEN** the in-process printable-runs scanner runs
- **AND** the scanner preserves CR / LF / tab characters as
  structural newlines (not as run terminators)
- **AND** the scanner preserves leading whitespace within each line
- **AND** the scanner does not deduplicate runs across the two passes
- **AND** the scanner prefers the UTF-16LE pass output when its
  byte coverage overlaps the ASCII pass
- **AND** the output is written to `incoming/<stem>/body.md` (not .txt)
- **AND** the manifest's `decompose.decomposer` =
  `opencode.legacy_ole2_scanner`

#### Scenario: .xls and .ppt take the same path

- **GIVEN** a user uploads a file with mime `application/vnd.ms-excel`
  or `application/vnd.ms-powerpoint`
- **WHEN** the dispatcher processes the upload
- **THEN** the same legacy scanner runs (mime-agnostic byte scan)
- **AND** the manifest's summary marks the extraction as
  "noisy, structure-guessable"

### Requirement: Modern xlsx / pptx surface as unsupported

#### Scenario: .xlsx upload writes unsupported note

- **GIVEN** a user uploads a .xlsx or .pptx file
- **WHEN** the dispatcher processes the upload
- **THEN** no decompose is attempted
- **AND** `incoming/<stem>/unsupported.md` is written explaining the
  constraint in plain language and advising conversion to .docx
- **AND** the manifest's `decompose.status = "unsupported"`
- **AND** the routing hint asks the AI to advise the user to convert

### Requirement: Routing hint is a map, never content

#### Scenario: routing hint never inlines body

- **GIVEN** any successfully decomposed `incoming/<stem>/`
- **WHEN** the message composer renders the routing hint
- **THEN** the hint lists each kind of artifact with file count and
  one-number summary only
- **AND** the hint never inlines body text, outline content, table
  cells, or any other readable content from the artifacts
- **AND** the hint always closes with the three-line action contract
  per DD-7 amended: pull-refresh rule (DD-13) on line 1, "use plain
  read tools" on line 2, "call docxmcp only for edits" on line 3

#### Scenario: routing hint folds long lists

- **GIVEN** a successful decompose with > 4 chapters
- **WHEN** the routing hint is rendered
- **THEN** the chapters line shows the first item plus
  `（還有 N 份，共 M 份）`
- **AND** the manifest itself is not folded (full list preserved)

### Requirement: Cross-cut — no silent fallback

#### Scenario: docxmcp extract_all entry missing on the host

- **GIVEN** the host is running a docxmcp build that does not yet
  expose `extract_all`
- **WHEN** the dispatcher tries to call it
- **THEN** the call surfaces as a soft-fail "docx tooling unavailable"
  via the failure path (above)
- **AND** the dispatcher does not silently fall back to "let the AI
  call docxmcp itself"

### Requirement: Telemetry records every decompose

#### Scenario: every upload emits one telemetry event

- **GIVEN** any Office upload (any format, any outcome)
- **WHEN** the dispatcher finishes processing
- **THEN** exactly one `incoming.decompose` event is emitted
- **AND** the event includes `{mime, byte_size, duration_ms, cache:
  "hit" | "miss", status: "ok" | "failed" | "unsupported", reason?}`

## Acceptance Checks

| ID | Check | Where verified |
|---|---|---|
| AC-1 | fast-phase latency p95 < 2 s for ≤ 1 MB inputs (before AI sees message) | integration test + production telemetry |
| AC-2 | fast-phase latency p95 < 15 s for ≤ 60 MB inputs (before AI sees message) | integration test |
| AC-2b | background phase latency p95 < 90 s for ≤ 60 MB inputs (manifest flips running→done) | integration test |
| AC-3 | Cache hit on identical re-upload: zero docxmcp calls | unit test on dispatcher |
| AC-4 | Sha drift triggers paired rename of OLD `<stem>.<ext>` + `<stem>/` to `<stem>-<old-uploaded-at>.<ext>` + `<stem>-<old-uploaded-at>/` (UTC, no colons); atomic; rollback both on any failure | unit test on version-rename helper |
| AC-5 | All 8 manifest `kind` values render correctly in routing hint, including fold | unit tests on routing hint generator |
| AC-6 | Soft-fail manifests have `reason` populated and no stack trace | schema validator + unit test |
| AC-7 | `incoming/` is git-ignored | grep `.gitignore`, run `git check-ignore` |
| AC-8 | attachment tool no longer references docx, .doc, .xls, .ppt, .xlsx, .pptx mimes | grep test in `attachment.ts` |
| AC-9 | Existing attachment tests still pass for image / PDF / text / JSON paths | run `bun test src/tool/attachment.test.ts` |
| AC-10 | Legacy scanner preserves at least 90% of newlines and leading whitespace from a known reference .doc fixture | scanner unit test against fixture |
