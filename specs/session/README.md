# session

> Wiki entry. Source of truth = current code under
> `packages/opencode/src/session/`,
> `packages/opencode/src/server/routes/session.ts`,
> `packages/opencode/src/server/session-cache.ts`,
> `packages/opencode/src/server/rate-limit.ts`,
> and the SolidJS web client in `packages/app/src/`.
> Replaces the legacy spec packages `session-storage-db`,
> `session-rebind-capability-refresh`, `session-ui-freshness`,
> `session-poll-cache`, `frontend-session-lazyload`,
> `mobile-session-restructure`, `mobile-tail-first-simplification`,
> `mobile-submit-durability`, and `20260501_frontend-dialog-stream-flattening`.

## Status

shipped (live as of 2026-05-04), with two open lanes.

- `session-rebind-capability-refresh` → `living` 2026-04-19
  (merge `eafee15ac`).
- `session-ui-freshness` → `verified` 2026-04-20
  (merge `4d7afc7e7`); flag default 0, bytes-equal to baseline.
- `frontend-session-lazyload` → `living` 2026-04-22
  (merges `490783777` for R1+R3-R6, `8a4e2df4b` for R9 cursor;
  R8 SSE bounded replay was superseded the next week).
- `mobile-session-restructure` → `living` 2026-04-23
  (merge `52d6b556c`); cisopro storage went 6.2 GB → ~1 GB.
- `mobile-tail-first-simplification` → `living` 2026-04-23
  (merge `c7f0ddb8b`); −550 LOC net continuity removal; deletes the
  R8/R9 protocols above and replaces them with one tail-first path.
- `session-storage-db` → `implementing`. Storage subsystem skeleton,
  router, dreaming worker, and `session-inspect` CLI are merged;
  full migration of legacy directories is staged as the dreaming
  worker drains them at idle.
- `session-poll-cache` → `implementing`. R-1 cache + R-2 ETag/304 +
  R-4 health endpoint + R-5 tweaks loader are live; R-3 rate limiter
  middleware is mounted in `app.ts`.
- `mobile-submit-durability` → `proposed` and **superseded**: the
  3-second-ACK + IndexedDB outbox plan was abandoned once the real
  cause (event-loop starvation from unbounded SSE replay) was fixed
  by lazyload G9/G10 and then by mobile-tail-first. Submit path
  retains client-side telemetry but no retry/dedupe protocol.
- `20260501_frontend-dialog-stream-flattening` → `planned`. Plan
  document and contract done; code slices in section 2 not yet
  started.

## Current behavior

### Storage: SQLite per session, dual-track router

`packages/opencode/src/session/storage/` owns persistence. The
`Backend` interface (`storage/index.ts`) is implemented twice:

- `LegacyStore` (`storage/legacy.ts`) — the original
  `session/<sid>/messages/<mid>/{info.json, parts/<pid>.json}` walk.
- `SqliteStore` (`storage/sqlite.ts`) — one `<sid>.db` file per
  session, WAL + `synchronous=NORMAL`, single-message atomic
  commits, attachment blobs in their own table.

`Router.detectFormat` (`storage/router.ts`) inspects the filesystem
on each call and dispatches accordingly. Both formats present with
no `.tmp` debris → SQLite wins (post-rename). Both present with
`.tmp` → LegacyStore is authoritative until startup cleanup deletes
the temp file (DR-4). Per **DD-13 / INV-4**, a SqliteStore error is
never silently re-routed to legacy; it propagates.

`ConnectionPool` (`storage/pool.ts`) caches DB handles. Schema
migrations live under `storage/migrations/` and run inside a single
transaction; failure rolls back and opens the DB read-only with a
`session.storage.corrupted` Bus event. `PRAGMA integrity_check` runs
on first open via `storage/integrity.ts`.

`DreamingWorker` (`storage/dreaming.ts`) sweeps legacy directories
when the daemon has been idle for `IDLE_THRESHOLD_MS` (default 5000),
migrates one session per tick (oldest-touched first), and aborts
mid-flight if a write arrives. Atomic rename to `<sid>.db` is the
commit point.

### Storage: session-inspect CLI

`opencode session-inspect list|show|check <sid>` recovers the
human-readable inspection capability that the directory layout
provided. Implemented in `cli/cmd/session-inspect.ts`; `check` calls
`runIntegrityCheckUncached` and exits non-zero on failure.

### Capability layer: rebind epoch is the only cache key

`packages/opencode/src/session/rebind-epoch.ts` exports a
`Map<sessionID, EpochEntry>` keyed only by epoch. There is no time
TTL. Triggers (`RebindTrigger` enum):

- `daemon_start` — first session use after daemon boot.
- `session_resume` — UI sends `POST /session/:id/resume`.
- `provider_switch` — pre-loop provider/account switch detection
  bumps before `compactWithSharedContext`.
- `slash_reload` — `/reload` slash command.
- `tool_call` — `refresh_capability_layer` tool dispatched from the
  AI; tool source at `tool/refresh-capability-layer.ts`.
- `file_mtime` — capability-layer source file mtime change.

`bumpEpoch` enforces a sliding-window rate limit of 5 bumps per
1000 ms per session (`REBIND_RATE_LIMIT`). Excess fires a
`session.rebind_storm` anomaly event and returns `rate_limited`
without bumping. Successful bump fires `session.rebind` workflow
event with `{previousEpoch, currentEpoch, trigger, reason}`.
`session.deleted` Bus events drop the registry entry automatically.

`CapabilityLayer.reinject(sessionID, epoch)` is the silent refresh
path — called by `POST /session/:id/resume` once the bump succeeds
and the session is not busy. Busy sessions are left alone (DD-5);
the in-flight runloop will cache-miss on the new epoch at its next
capability lookup. The reinject reply carries
`{layers, pinnedSkills, missingSkills, failures}` so dashboards can
update without a roundtrip to LLM.

### Session HTTP cache + ETag/304

`server/session-cache.ts` is an in-process LRU plus a per-session
monotonic `version` counter. `Session.Event.Updated` /
`MessageV2.Event.Updated/Removed/PartUpdated/PartRemoved` increment
the version and drop all keyed entries; `Session.Event.Deleted`
clears the counter entirely. Streaming `PartUpdated` deltas are
debounced into one invalidation per 100 ms per session so token
storms don't thrash the cache.

ETags are `W/"<sessionID>:<version>:<processEpoch>"`. The process
epoch keeps stale client ETags from matching after a daemon restart.
`GET /session/:id`, `GET /session/:id/meta`, and the tail branch of
`GET /session/:id/message` all check `If-None-Match` and return 304
without serializing a body.

If the bus subscription fails, the cache is marked unhealthy
(`subscriptionAlive=false`); reads fall through to the disk loader
and the failure surfaces in `GET /api/v2/server/cache/health`.
There is no silent fall-back; `log.warn` is mandatory (AGENTS.md
rule 1).

### Rate limit

`server/rate-limit.ts` is a Hono middleware mounted in `app.ts` at
the root. Per-user × per-path token bucket; 429 replies carry
`Retry-After` and a `{code, message, path, retryAfterSec}` body. The
internal hostname `opencode.internal`, `/log`, `/api/v2/server/health`,
and `/api/v2/server/cache/health` are exempt. `ratelimit_enabled=0`
disables it and the daemon prints
`rate-limit disabled via tweaks.cfg` at startup.

### `/etc/opencode/tweaks.cfg` keys

`config/tweaks.ts` is the single loader. Cache + rate-limit:
`session_cache_enabled`, `session_cache_ttl_sec`,
`session_cache_max_entries`, `ratelimit_enabled`,
`ratelimit_qps_per_user_per_path`, `ratelimit_burst`. Tail sizing:
`session_messages_default_tail` (30), `session_tail_mobile` (20),
`session_tail_desktop` (100). UI freshness:
`ui_session_freshness_enabled`, `ui_freshness_threshold_sec`,
`ui_freshness_hard_timeout_sec`. Lazyload + part fold:
`frontend_session_lazyload`, `part_inline_cap_kb`,
`part_fold_preview_lines`, `initial_page_size_small/medium/large`,
`session_size_threshold_kb`, `session_size_threshold_parts`. Unknown
keys → `log.warn`. Malformed values fall back to defaults but warn.

### Frontend: tail-first attach, scroll-up loads older

`GET /session/:id/message` is the only load path. With no `before`
query, returns the chronological tail of `effectiveLimit` messages
(`limit ?? session_messages_default_tail`). With `before=<id>`,
returns `effectiveLimit` messages strictly older than that id —
this is the cursor branch and is **not** ETag-cached; only the tail
is. `Last-Event-ID`, `beforeMessageID`, and the SSE event-replay
buffer are deleted.

The web client (`packages/app/src/context/sync.tsx`) hydrates by
calling `session.messages` with `limit = session_tail_mobile` on
mobile, `session_tail_desktop` on desktop. Re-entering the session
route discards the store and re-fetches the tail; there is no resume
or delta merge. SSE delivers only events that occur after the
subscription starts (`server/app.ts` SSE handler); on reconnect,
events lost during the drop stay lost — recoverable only by user
scroll-up.

`loadOlderMessages(before, limit)` prepends to the existing store
and never refetches the whole slice. A global LRU cap (mobile 200,
desktop 500) evicts oldest non-streaming messages; live-streaming
messages are protected.

### Frontend: large-session escape hatch

`GET /session/:id/meta` returns `{partCount, totalBytes, lastUpdated}`
without deserializing parts. The webapp's session-list / open-root
flow consults this gate when `frontend_session_lazyload=1`: if the
remembered last session exceeds `session_size_threshold_parts` (80)
or `session_size_threshold_kb` (512), it routes to the `/sessions`
list with a toast instead of forcing the user into the heavy session.
A meta fetch failure also routes to `/sessions` rather than silently
loading the last session (AGENTS.md rule 1).

`pageSizeFor(partCount)` picks the initial fetch size:
≤50 → small (default 30), ≤200 → medium (default 100), else large
(default 50). Flag off → falls back to legacy `messagePageSize`.

### Frontend: part-level fold + tail window

Parts whose text exceeds `part_inline_cap_kb` (default 64 KB) and
belong to a `completed` message are rendered as a
`FoldableMarkdown` preview (first `part_fold_preview_lines`, default
20) with an "expand" button. Streaming parts that exceed the cap
render only the last 64 KB with a "streaming, last 64 KB" hint;
when the message completes, they collapse to the standard fold UI.

Per-part overflow during streaming is hard-capped at 500 KB:
`truncatedPrefix` records dropped byte count. User-clicked expand
calls a part-scoped fetch via `data.expandPart` (DD-6) that rebuilds
just that part — never a full `syncSession()`.

`event-reducer.ts` distinguishes append-mode AI SDK rebuilds
(prefix-match → `existing + delta`) from real replacements; the
prefix-match path logs `[lazyload] rebuild-detected` and avoids the
re-render storm.

### Frontend: freshness

`packages/app/src/utils/freshness.ts` is the single source of truth
for fidelity classification. `classifyFidelity(receivedAt, now,
{softSec, hardSec}, enabled)` returns `fresh` / `stale` /
`hard-stale`. Three protected stores stamp `receivedAt = Date.now()`
in their reducer: `session_status[sid]`, `active_child[sid]`,
`session_monitor[sid]`. A separate `useFreshnessClock()` ticks
once per second and drives all freshness-aware memos.

DD-4: missing / NaN / Infinity / negative `receivedAt` → treated as
0 → renders hard-stale. A rate-limited (`≤1/min/entry`) console.warn
records the anomaly. Never silently rendered as fresh.

`globalSDK.connectionStatus()` and `GlobalConnectionStatus` are
removed (DD-6). SSE auto-reconnect (`EventSource` native behaviour)
is retained; the UI no longer surfaces connection state. PromptInput
is no longer gated by SSE health — block reasons are limited to
pending permission/question. Submit goes via REST POST regardless of
SSE.

`ui_session_freshness_enabled` defaults to 0 — render is byte-equal
to pre-plan baseline. Flag = 1 enables soft-stale (`≥15 s`) and
hard-stale (`≥60 s`) UI states.

### Subagent context dispatch: stream-anchor rebind, no Codex fork

Child sessions (`session.parentID != null`) receive a bounded
`parentMessagePrefix` instead of the parent's full history. Priority
order in `prompt.ts` (~L948):

1. **Stream-anchor rebind** — `applyStreamAnchorRebind` scans the
   parent's filtered message stream for the most recent compaction
   anchor and slices from there. The anchor message itself contains
   the compacted summary text; no separate checkpoint file is read.
   `parentContextSource = "checkpoint"`.
2. **Recent history** — last `PARENT_CONTEXT_MAX_ROUNDS` (10) user→
   assistant rounds when no anchor exists.
   `parentContextSource = "recent_history"`.
3. **None** — logged when the parent stream is empty.

Codex `previous_response_id` fork dispatch was attempted and reverted
(commit `1b50e1d40`, 2026-04-10): the Responses API continuation chain
is per-WS-connection, so child WS connections always failed with
`previous_response_not_found`. Codex subagents now use the same
stream-anchor path as every other provider; the legacy
`codexForkResponseId` / `isForkSeed` symbols no longer exist in the
codebase.

`Snapshot.FileDiff` no longer carries `before` / `after` bodies on
any persisted, wire, or render path. `summary.diffs[]` entries are
metadata only: `{ path, additions, deletions, status? }`. The
desktop review tab, mobile session UI, and enterprise share page
each render one row per file with no expand control and no network
request for diff content. The workspace owned-diff check (per-turn
git snapshot is the authoritative source) calls git directly against
the snapshot commit.

`cli/cmd/maintenance/migrate-strip-diffs.ts` is the offline migration
that strips legacy `before/after` from existing
`session_summary.diffs` records (atomic temp-write + rename, with a
per-session marker for resumability). Confirmed result on cisopro:
6.2 GB → ~1 GB and the mobile white-flash symptom resolved.

### Submit path (current state)

`packages/app/src/components/prompt-input/submit.ts` is a single
fetch with `[submit] send start | send ok | send failed` telemetry
and an `AbortController` tied to component teardown. There is no
3-second ACK timer, no exponential retry, no IndexedDB outbox, and
no server-side `messageID` dedupe. The 2026-04-22 mobile silent-drop
RCA reattributed the symptom to daemon event-loop starvation
(unbounded SSE replay + full-history hydrate), which the lazyload
G9/G10 fix and the subsequent mobile-tail-first deletion eliminated.
See **Notes — superseded surface** below.

### Dialog stream flattening (planned, not yet implemented)

The plan in `specs/_archive/20260501_frontend-dialog-stream-flattening/`
defines the contract — one `DialogStreamCanvas` of cards
(UserInput, AssistantText, ToolCall, ToolResult, Error) plus one
`TurnStatusLine`, with the outer page scroll as the single owner.
Wrapper inventory and merge plan for `SessionStreamPanel` /
`TaskSessionOutput` are written; implementation slices 2.A–2.F have
not been executed.

## Code anchors

Storage:
- `packages/opencode/src/session/storage/index.ts` — Backend
  contract + namespace seam (L13).
- `packages/opencode/src/session/storage/router.ts` — `detectFormat`
  (L75), per-call dispatch, debris cleanup scheduling.
- `packages/opencode/src/session/storage/sqlite.ts` — SqliteStore.
- `packages/opencode/src/session/storage/legacy.ts` — LegacyStore.
- `packages/opencode/src/session/storage/dreaming.ts` —
  background migration (DreamingWorker).
- `packages/opencode/src/session/storage/migration-runner.ts` — schema
  migrations.
- `packages/opencode/src/session/storage/integrity.ts` —
  `runIntegrityCheckUncached`.
- `packages/opencode/src/session/storage/pool.ts` — connection cache.
- `packages/opencode/src/cli/cmd/session-inspect.ts` — list/show/check.
- `packages/opencode/src/cli/cmd/maintenance/migrate-strip-diffs.ts` —
  one-shot diff body stripper.

Capability layer + rebind:
- `packages/opencode/src/session/rebind-epoch.ts` — epoch registry,
  rate limit (`REBIND_RATE_LIMIT` at L226), `bumpEpoch` (L132),
  bus subscription (L67–73).
- `packages/opencode/src/session/capability-layer.ts` — reinject path.
- `packages/opencode/src/session/prompt.ts` —
  `applyStreamAnchorRebind` (L559); subagent `parentMessagePrefix`
  dispatch (L948).
- `packages/opencode/src/session/capability-layer-loader.ts` —
  cache-aware loader.
- `packages/opencode/src/tool/refresh-capability-layer.ts` —
  AI-facing tool (per-session 3/turn limit).
- `packages/opencode/src/command/index.ts` — `/reload` slash command
  handler (L82).

Server cache + ETag + rate limit:
- `packages/opencode/src/server/session-cache.ts` — LRU + version
  counter + ETag (L96 process-epoch comment, `currentEtag`,
  `isEtagMatch`, `get`); 100 ms PartUpdated debounce at L76.
- `packages/opencode/src/server/rate-limit.ts` — Hono middleware,
  registered in `app.ts:234`.
- `packages/opencode/src/server/routes/cache-health.ts` — health
  endpoint and stats provider registry.
- `packages/opencode/src/config/tweaks.ts` — known-keys list (L439),
  per-key parsers + warn-on-malformed.

Session HTTP routes:
- `packages/opencode/src/server/routes/session.ts`
  - `/:id/meta` (L457).
  - `/:id/resume` (L736–828) silent refresh.
  - `/:id/message` (L1818–1916) with `before` cursor branch (L1882)
    and ETag-cached tail branch (L1899).
  - `/:id` (L429) and message-by-id (L1919) — both ETag-cached.

Frontend (web):
- `packages/app/src/context/sync.tsx` — `pageSizeFor` (L190),
  `fetchSessionMeta` (L205), `loadOlderMessages` (L321),
  `patchPart` for FoldableMarkdown expand (L367), `isMobile()`
  (L168), tail size selection (L456).
- `packages/app/src/context/frontend-tweaks.ts` — flag + part-cap
  defaults.
- `packages/app/src/utils/freshness.ts` — `classifyFidelity`,
  `createRateLimitedWarn`.
- `packages/app/src/hooks/use-freshness-clock.ts` — 1 Hz tick.
- `packages/app/src/pages/session.tsx` — message timeline +
  side-panel consumers.
- `packages/app/src/pages/session/message-timeline.tsx` — scroll-spy
  sentinel calls `history.loadMore()`.
- `packages/app/src/pages/layout.tsx` — root-session escape hatch
  (`openSession` flow L1085–1140).
- `packages/app/src/components/prompt-input/submit.ts` — single-shot
  POST + telemetry.
- `packages/app/src/context/global-sync/event-reducer.ts` —
  rebuild-vs-append heuristic.

Tests (representative):
- `session/rebind-epoch.test.ts`,
  `session/capability-layer.test.ts`,
  `session/capability-layer.cross-account.test.ts`.
- `session/storage/{router,sqlite,legacy,hardening,dreaming}.test.ts`.
- `server/session-cache.test.ts`, `server/rate-limit.test.ts`,
  `server/cache-health.test.ts`.
- `app/utils/freshness.test.ts`,
  `app/context/global-sync/event-reducer.test.ts`,
  `app/components/prompt-input/submit.test.ts`,
  `app/components/prompt-input/history.test.ts`.
- `cli/cmd/session-inspect.test.ts`.

## Notes

### Open / partial work

- `session-storage-db` is `implementing`. The storage layer + router
  + dreaming worker + inspect CLI are merged, and the runloop reads
  through the new `Backend` API. Legacy directories on disk drain
  asynchronously as DreamingWorker reaches them; the dual-track path
  is the steady state until that backlog is empty. The 70 % runloop
  speed-up acceptance check has not been re-verified end-to-end on
  the 2253-message reference session.
- `session-poll-cache` is `implementing`. R-1 cache + R-2 ETag +
  R-4 health + R-5 tweaks loader + R-3 rate-limit middleware are
  all live, but the original AC-1 (CPU drop) and AC-2 (304 ratio)
  measurements have not been re-baselined post-mobile-tail-first.
- `frontend-session-lazyload` Phase 2 (escape-hatch UI) was
  intentionally skipped — Phase 3 tail-window already bounds
  streaming OOM.
- Dialog stream flattening
  (`20260501_frontend-dialog-stream-flattening`) is `planned`. The
  plan + design + invariants are recorded but no code slice has been
  executed.

### Superseded surface

- `mobile-submit-durability` — the 3 s ACK + retry + IndexedDB outbox
  proposal is **abandoned**. RCA reattributed silent submits to
  daemon event-loop starvation, fixed upstream by lazyload G9
  (bounded SSE replay) and then by the deletion of SSE replay
  entirely under mobile-tail-first. The proposal is kept as audit
  trail; reopen only if a true OS-freeze residue surfaces.
- `frontend-session-lazyload` R8 (SSE bounded replay) and R9
  (`beforeMessageID` cursor) are superseded by mobile-tail-first.
  R8 mechanism is gone; R9's `beforeMessageID` was renamed to the
  canonical `before` query param, and cold-open tail-first behaviour
  is now controlled by `session_tail_mobile` /
  `session_tail_desktop` rather than R9's protocol.

### Known tech debt

- **Ghost responses bug** (open since 2026-03-11). After switching
  accounts in the admin panel, the AI responds server-side but the
  TUI does not render the response in real time; revisiting the
  session later shows the responses. Suspected SSE/sync layer issue
  during account state transitions. Could not be reliably reproduced
  after the 2026-04-18 accounts.json restore. Investigation angles:
  Bus event delivery during account state transitions, SSE
  reconnection after admin dialog open/close, and stale
  `session_status` / `sync.data` blocking the UI update.
- Dreaming worker is per-tick single-session; if the legacy backlog
  is very large the queue drains slowly. No batched-tick mode yet.
- Submit path has no server-side `messageID` dedupe. If the
  event-loop-starvation regression returns, a duplicate POST will
  re-run the runloop. Acceptable today because the upstream cause is
  fixed.

## Sub-packages

- [continuation-fix/](./continuation-fix/) (needs-update — core
  mechanisms shipped, 2026-05-04 audit) — orphan-task recovery,
  session version guard, worker pre-bootstrap logger, tool-input
  normalization, processor execution-identity validation. Open:
  1.5 / 2.5 / 3.5 / 4.6 / 5.5 automated regression tests, 2.4
  staleVersion UI surface.

### Related entries

- [compaction/](../compaction/README.md) — runloop, anchors, idle gate;
  `provider-switched` observed value coordinates with the rebind
  epoch path described here.
- [provider/](../provider/README.md) — provider/account boundary; the
  pre-loop switch detector is the call-site that bumps epoch with
  `trigger=provider_switch` before `compactWithSharedContext`.
- [provider/claude/](../provider/claude/README.md) — Claude Code
  native takeover import path that produces sessions consumed by
  this runloop.
- [account/](../account/README.md) — admin-panel account-switch flow that
  the ghost-responses bug is suspected to interact with.
- [attachments/](../attachments/README.md) — oversized attachment blobs
  live in the per-session SQLite namespace via
  `upsertAttachmentBlob` / `getAttachmentBlob`; the wire-payload
  metadata-only contract for diffs is the same shape applied here.
- [harness/](../harness/README.md) — capability-layer / lane policy
  is the agent surface that `RebindEpoch` invalidates (formerly
  `agent-runtime/`).
