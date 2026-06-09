---
date: 2026-06-09
summary: "Phase 1 event index engine landed and verified (AC1/AC2/AC5/AC9 green)"
---

# Phase 1 event index engine landed and verified (AC1/AC2/AC5/AC9 green)

## Scope

Built the events index engine in the specbase repo (branch main, from head 1a350aa). Implementation deviated from the task wording in one deliberate way: rather than extend `indexRepo`/`IndexOptions`, added a **separate `packages/lib/src/events-indexer.ts`** (+ `cli/index-events.ts`) that reuses the schema + parser but never touches the spec path. This makes the G1 isolation structural, not conventional.

### Changes (specbase repo, uncommitted)
- `packages/lib/src/parser.ts` — added `renderHtml?: boolean` to ParseOptions (default true); events pass false to skip body_html.
- `packages/lib/src/events-indexer.ts` (new) — `indexEvents()`: flat-file globs `docs/events/**/*.md` + `plans/**/events/*.md`, slug = repo-relative path minus `.md`, `created` parsed from filename (`YYYYMMDD`|`YYYY-MM-DD`, null on no-match), `type='event'`, body_html skipped, wholesale rebuild of a dedicated `.specbase/events.sqlite`. Guards: refuse to write into `index.sqlite` (DD-2), refuse empty-write on zero matches (E-IDX-1). Excludes `EVENT_LOG_UNIFIED.md` (DD-8 retired aggregate → duplicate-content pollution).
- `packages/lib/src/cli/index-events.ts` (new) — rebuild CLI (serves P3-1).

### Glob refinement during the run
First run matched 849 (non-recursive `docs/events/*.md` = 768 + 81 plans). Switched docs pattern to `docs/events/**/*.md` to include the 144-file `docs/events/archive/` subtree (archived events are exactly the old history recall wants), minus EVENT_LOG_UNIFIED.md → **992 entries**.

## Validation

- **AC1**: events.sqlite entries=992, type='event'=992, fts_rows==entries. (912 docs + 81 plans − 1 UNIFIED.)
- **AC2 (isolation)**: spec index `.specbase/index.sqlite` byte-identical before/after — entries=22, links=445, fts_rows=22, and the fixed 'compaction' top-5 BM25 ranking unchanged.
- **AC3**: `event_search('phantom AND account AND 529')` returns exactly `event_20260606_claude-cli-phantom-accounts-529-and-login-label` (rank −22.414).
- **AC5**: 1 undated file (`docs/events/opencode_hotfix_0501` — '0501' is not a full date) indexed with created=null, did NOT abort the batch, and remains full-text reachable.
- **AC9**: full rebuild ~1.5s; events.sqlite 8.8MB (well under 35MB).
- typecheck: `tsc --noEmit` clean.

## Remaining

- Phase 2: `event_search` / `event_query` MCP tools (currently proven via raw SQL only).
- Phase 3: refresh trigger (CLI exists; optional post-commit hook).
- Phases 4–6: AGENTS.md wiring, MEMORY.md migration, gated empty.
- specbase changes are uncommitted on main; commit per G3 when the user is ready.
