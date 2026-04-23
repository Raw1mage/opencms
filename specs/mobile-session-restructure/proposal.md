# Proposal: mobile-session-restructure

## Why

On 2026-04-23 the user reported that mobile clients collapse during
normal use of long-running sessions: every user input triggers a full
white-flash reload, only the tail of conversation loads, scrolling up
fails to retrieve earlier messages, and session entry that used to be
instant now drags on for long periods. Investigation uncovered a
deeper, older problem that also explains the symptoms: the daemon has
been storing duplicate copies of file contents in every user message,
wasting gigabytes of disk and megabytes of mobile bandwidth per event.

### The actual root cause (2026-04-23 second-pass RCA)

Every user message's stored record carries a `summary.diffs` array.
Each entry describes one file touched by the assistant in that turn.
The schema stores both:

- lightweight metadata: file path, addition / deletion counts, status
- **full file body before the turn** and **full file body after
  the turn**

The daemon already maintains a git-based snapshot system: every turn
creates a git commit capturing the worktree state. A `git diff`
between two snapshot commits reconstructs any before / after content
on demand. Storing those contents inline in the message record is
redundant.

Upstream history makes this plain:

- **2025-10-20**: the file-diff shape was introduced carrying only
  metadata (`file`, `additions`, `deletions`).
- **2025-10-21 (next day)**: full before / after string fields were
  appended to the schema.
- **2026-03-15**: these diffs started being embedded in each user
  message's stored record.

The added content was never used by any code path that could not
equally have asked git. It duplicates information that already lives
in the snapshot git repo, and it now dominates disk usage and wire
bandwidth.

### Measured impact on this machine

- Total session storage: **6.2 GB** across 2 545 sessions.
- Heaviest single session: **932 MB**; next five all above 100 MB.
- Within sampled message records, **90 % of the stored bytes are
  those before / after strings**. Metadata is trivial; file bodies
  dominate.
- A 2-hour workload on the 51 MB reference session produced mobile
  symptoms consistent with the wire-level cost of this bloat.

### Triple symptom, single cause

- White flash per input = every new update re-ships multi-MB of file
  bodies that the mobile UI cannot meaningfully render.
- Only-tail-loads, scroll-up-fails = even tail-30 messages is ~135 MB
  at current sizes; pagination works, but every page is prohibitive.
- Slow session entry = initial fetch hits the same ~135 MB wall.

All three collapse when the file bodies are removed from both disk
storage and wire payloads. The yesterday-shipped lazyload
(SSE replay bound + messages cursor) is correctly scoped and stays —
it just gets its promised "seconds to open" back once payloads
shrink.

### Asymmetry principle (user's framing)

- **Client → server** file upload is legitimate (screenshots,
  pasted content, files the user wants the AI to see). This spec
  does not restrict that direction.
- **Server → client** file bodies are not legitimate when the
  client is a conversation viewer. The viewer needs "AI touched
  these files" metadata; actual contents can be fetched on demand
  if a UI explicitly chooses to show them.

## Original Requirement Wording (Baseline)

> 「過程中比較嚴重的問題是畫面自動閃白色…每輸入一句 dialog 就整個
> 閃白色再重新來過。」
>
> 「我仔細想想覺得真正的問題是這 51MB 究竟是什麼？如果是純對話，
> 就算同一個 session 連續對話個幾天也累積不了 51MB 的文字訊息。」
>
> 「不是吧？AI 動過的檔案都在 server 端。手機只是 client，只需要
> 對話，不需要傳檔。」
>
> 「我可以想像得到傳大檔的情境，就是我用手機截圖要告訴 AI 特定
> 的事情時。」
>
> 「請問每改一個檔都完整儲存，這件事是什麼時候開始的？我們的 repo
> 很大耶，改過的檔案成千上萬，全都用這種方式重複儲存了？不是有
> Git 嗎？為什麼要儲存成對話紀錄的 payload。」
>
> 「同意你擴大處理。我本來就很少在 webapp 上用 diff 看檔案。」
>
> — user, 2026-04-23 conversation

## Requirement Revision History

- 2026-04-23 first draft: aimed at session-update delta protocol.
  Based on wrong RCA.
- 2026-04-23 second draft: corrected to strip before / after from
  wire payloads only; disk unchanged.
- 2026-04-23 third draft (current): user pushed back that file
  bodies are git-recoverable and disk duplication makes no sense.
  Expanded scope: remove before / after from **both wire and disk**,
  provide on-demand git-derived reconstruction for the rare reader
  that actually needs them, and migrate existing session storage.

## Effective Requirement Description

1. **Disk stops storing file bodies in user-message records.** The
   file-diff entries persisted inside each user message's stored
   record no longer carry before / after string fields. Only
   metadata (path, addition count, deletion count, status, snapshot
   commit reference) remains.
2. **Wire payloads never ship file bodies for conversation reads.**
   All server-to-client serializations (HTTP message fetch, SSE
   message-update events, share service export) carry only the
   lightweight shape.
3. **Diff content is a "nice-to-have" feature served by git on
   demand.** Actual before / after bodies are NEVER cached,
   mirrored, or pre-computed anywhere in the daemon; they are
   derived live from the per-turn snapshot git repo only when
   something explicitly asks for them.
4. **A new on-demand endpoint** exposes one file's diff at a
   time to clients that explicitly want to render it. It is a
   thin wrapper over git's native diff capability. Mobile UIs
   simply never call it and pay zero cost.
5. **Client-to-server uploads are unchanged.** Users uploading
   screenshots / files to the AI keeps working exactly as today.
6. **Historical sessions are migrated.** A one-shot cleanup pass
   strips before / after fields from existing message records
   on disk, so the ~5.5 GB of current duplication actually frees
   up. Migration is safe (git snapshots retain the truth) and
   idempotent (re-running is a no-op).
7. **Observable outcome**: total session disk usage drops by
   ~90 %. Entering a previously-problematic session on mobile is
   again a seconds-scale experience; no white flash on input.

## Scope

### IN

- **Schema simplified**: the file-diff type loses its before / after
  fields outright. There is no "internal-only transient full shape";
  the metadata-only form is the only form anywhere in the daemon.
- **Diff generator refactor**: the code that produces diffs at
  end-of-turn computes only the metadata (additions, deletions,
  status) — it never reads full file bodies into memory just to
  stash them. If the tight path truly needs line counts without
  invoking git, that's an implementation detail inside the
  generator; nothing persisted or transmitted.
- **Server reader refactor**: the one server-side reader that
  currently relies on before / after (the workspace owned-diff
  check) switches to asking git for contents on demand.
- **Frontend reader refactor**: the three frontend locations that
  render inline diffs (the session review tab, the session-review
  shared UI component, and the public share page) switch to the
  new on-demand endpoint, loaded when the user expands a diff.
- **On-demand endpoint**: a new HTTP route returns the full
  content for one file in one turn, identified by session + message
  + file. Reuses existing session-read authorization.
- **Historical migration script**: scans every session on disk,
  rewrites each message record to drop before / after. Records a
  migration marker so it is not re-run against already-migrated
  sessions. Atomic per-message file write; rollback is "restore
  from backup". Pre-migration disk snapshot captured as
  `~/.local/share/opencode/storage/session.bak-<ts>/` (user runs
  this manually; automatic backup is out of scope).
- **Observability**: log migration progress + skipped sessions.
  Daemon startup logs the migration marker presence so operators
  can detect stragglers.
- **Acceptance**: total storage dir drops to ≤ 1 GB after
  migration; mobile session entry time returns to "seconds"; no
  visible white flash on input; owned-diff check still produces
  correct results; diff expansion in the desktop UI still renders
  correctly.

### OUT

- **Delta protocol for the session-updated event.** Not needed
  once the payload it carries is small; off the table.
- **Changes to how git snapshots themselves are managed.** We
  rely on the existing snapshot commit lifecycle unchanged.
- **I-1 subagent status bar hydration on reload / multi-client.**
  Separate concern; separate spec.
- **Upward pagination UX polish.** Already works; just becomes
  fast again after the fix.
- **Part-level streaming delta optimisation.** Handled elsewhere.
- **Auth / access-control changes.** Same authorization model.
- **Non-user-message carriers of diffs (if any)** — to be verified
  during design; if some other record type also carries the
  before / after strings, they are in scope by implication but
  currently no evidence that any does.

## Non-Goals

- Reducing the number of events or their frequency.
- Changing the snapshot / git retention policy.
- Supporting clients that insist on receiving inline file bodies
  — they must migrate to the on-demand endpoint or render
  metadata only.

## Constraints

- **No git dependency change.** The feature relies on the existing
  per-turn git snapshot; if that mechanism is disabled for a
  session (edge case), the server reads a stored snapshot commit
  reference from the slim record. If even that is missing, the
  endpoint returns an explicit `snapshot_unavailable` error —
  the UI shows the metadata but declines to expand, rather than
  rendering empty or fabricated content (AGENTS.md rule 1 — no
  silent fallback).
- **Migration must be restartable.** If the machine reboots mid-
  migration, running the script again picks up where it left
  off. Determined by the per-session migration marker.
- **Migration must be reversible via backup.** The user takes the
  backup before running the script; the script itself does not
  retain originals.
- **Wire payload shape change is breaking for any client that
  reads before / after inline.** Acceptable — we audit and update
  all known readers as part of this spec. Unknown external
  consumers are notified via release notes.
- **Event name unchanged.** `bus.message.updated` keeps firing;
  only the embedded diff shape shrinks.
- **Owned-diff semantics preserved bit-for-bit.** The workspace
  integrity check must continue to produce the same answers;
  refactoring it to git-derive is a mechanical lift, not a
  semantic change.

## What Changes

- **Message record schema**: stored file-diff entries lose
  before / after.
- **Diff generation path**: writes the slim shape.
- **Wire serialization**: already carries the persisted shape, so
  this becomes automatic once disk is slim.
- **Workspace owned-diff reader**: refactored to fetch contents
  from the per-turn snapshot commit via git, on demand.
- **New on-demand route**: `GET /api/session/<sid>/messages/<mid>/diffs/<fileEncoded>`
  returns the full single-file diff shape (server reads from git,
  builds the response). Same auth as the session message-read
  path.
- **Frontend**: three consumer locations switch to call the
  on-demand endpoint when the user expands a diff. Collapsed /
  preview views render metadata only.
- **Migration script** lives under the runtime maintenance
  surface; operator runs it once, then normal operation keeps
  sessions slim from then on.
- **Tests**: round-trip (write slim, read slim, owned-diff still
  passes), migration idempotency, on-demand endpoint correctness
  against a fixture session.

## Capabilities

### New Capabilities

- **Metadata-only session records and wire payloads** — conversation
  reads download KB instead of MB.
- **On-demand single-file diff fetch** — clients pay only for what
  they render.
- **Git-derived diff reconstruction** — server uses the existing
  snapshot graph as the source of truth for file bodies.

### Modified Capabilities

- **File-diff shape on disk and on wire**: from full bodies + metadata
  to metadata only. Full bodies are computed from git on demand.
- **Existing sessions post-migration**: slim, compatible with new
  code paths.

## Impact

- **Affected code**: diff generator, workspace owned-diff check,
  message record schema, session message route (adds on-demand
  sub-route), SSE serialization, share service export, three
  frontend diff-rendering components, migration script.
- **Affected clients**: all — but only the desktop web and
  enterprise share pages have actual diff-rendering code that
  changes. Mobile gains silently.
- **Operators**: one-time manual migration + daemon restart. Back
  up first.
- **Risk classes**:
  - Any hidden reader of before / after not surfaced in the audit
    → renders empty. Mitigated by grep audit + failing-loud on
    the new slim type (type-level guarantee that before / after
    are absent at the boundary).
  - Snapshot git missing for a legacy session → on-demand
    expansion fails. Mitigated by explicit error + metadata-only
    display.
  - Migration script corrupting a session file mid-write →
    mitigated by operator-side backup + per-file atomic rewrite
    (write-temp + rename).
  - External share-service consumers reading inline before / after
    → mitigated by providing the on-demand endpoint publicly with
    the same auth scope; release notes document the change.
