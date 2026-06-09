# Tasks

Implementation order is load-bearing: **index first (prove retrieval) → AGENTS.md wiring → MEMORY.md migration → empty MEMORY.md last.**

## Phase 0 — Preconditions (before any code)

- [x] P0-1 XDG backup: copy `~/.config/opencode/` whitelist files to `~/.config/opencode.bak-<YYYYMMDD-HHMM>-three-tier-recall/` (per project CLAUDE.md).
- [x] P0-2 Confirm specbase repo state at `/home/pkcs12/projects/specbase/` (clean tree; note branch).
- [x] P0-3 Snapshot baseline: record current spec index counts (`entries`, `links`, fts_rows) for AC2 isolation check.

## Phase 1 — Event index engine (specbase repo)

- [x] P1-1 Add `eventSourceOptions` (eventGlobs, dbPath, deriveSlugDateFromFilename, renderHtml=false) to IndexOptions in `packages/lib/src/indexer.ts`.
- [x] P1-2 Add a flat-file discovery path (glob `docs/events/*.md` + `plans/**/events/*.md`) alongside the existing `**/README.md` specs path.
- [x] P1-3 Implement filename → slug + `created` derivation (parse `YYYYMMDD` and `YYYY-MM-DD`); null `created` on no-match without aborting the batch (AC5).
- [x] P1-4 Target a separate DB file (`.specbase/events.sqlite`), reusing the existing schema; set `type='event'`; skip body_html render.
- [x] P1-5 Run a full rebuild over the real 993 files; capture duration + DB size (AC9).
- [x] P1-6 Verify spec index untouched: re-check `.specbase/index.sqlite` counts vs P0-3 baseline (AC2).

## Phase 2 — Event query surface (specbase MCP)

- [x] P2-1 Add `event_search` (BM25 full-text over events.sqlite) to `packages/mcp/src/index.ts`, mirroring `wiki_search` but pointed at the events DB.
- [x] P2-2 Add `event_query` (date-range / tag / status filter) mirroring the DSL approach.
- [x] P2-3 Smoke test: `event_search` on a known RCA keyword returns the right event with ranked snippet < 50ms (AC3); `event_query` date filter correct (AC4).

## Phase 3 — Refresh trigger

- [x] P3-1 Expose on-demand rebuild (MCP tool or CLI) for events.sqlite.
- [x] P3-2 (optional) Wire a post-commit git hook in opencode to rebuild on event-file changes; document the trade-off if skipped.

## Phase 4 — AGENTS.md wiring

- [x] P4-1 Author the eager three-tier routing rule (< 25 lines, AC6): session for "what I just did", event for "why/RCA", spec for "current design"; name the tools.
- [x] P4-2 Add a `## Provisional` subsection convention for un-promoted behavioral preferences.

## Phase 5 — MEMORY.md migration (NON-destructive first)

- [x] P5-1 Classify every MEMORY.md entry by the taxonomy (rule / history / procedure / churn).
- [x] P5-2 Route rules → AGENTS.md (or Provisional); confirm each historical/RCA entry already exists in git+events (or write a new event for any that doesn't).
- [x] P5-3 Split the "3R" procedure into a `/3r` skill/command (encapsulate legal path + no-self-start + three-greens verify).
- [x] P5-4 Verify every migrated item is findable via its tool (`event_search` / AGENTS.md / skill) — produce the verification list (AC7).

## Phase 6 — Destructive finalization (gated)

- [x] P6-1 Retire `EVENT_LOG_UNIFIED.md` to a < 5-line stub pointing at `event_search` (AC8).
- [x] P6-2 **Only after P5-4 passes**: empty MEMORY.md (keep topic files / git history as the recoverable original).
- [x] P6-3 Record an event documenting the retirement + the new three-tier contract.

## Phase 7 — Verification

- [x] P7-1 Walk AC1–AC9; attach evidence.
- [x] P7-2 `spec_record_event` with the rebuild metrics, isolation proof, and migration verification list.
