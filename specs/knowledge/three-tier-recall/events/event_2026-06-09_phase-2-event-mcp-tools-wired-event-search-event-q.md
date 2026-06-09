---
date: 2026-06-09
summary: "Phase 2 event MCP tools wired (event_search / event_query / event_rebuild), AC3/AC4 green"
---

# Phase 2 event MCP tools wired (event_search / event_query / event_rebuild), AC3/AC4 green

## Scope (specbase repo, uncommitted)

- `packages/lib/package.json` — exported `./events-indexer`.
- `packages/mcp/src/index.ts` — added `eventsDbPathFor` / `openEventsReadonly` helpers (env `SPECBASE_EVENTS_DB_PATH`, default `.specbase/events.sqlite`) and three tools:
  - **event_search** — BM25 full-text over events.sqlite. Uses **term-AND** match semantics (split query into words, AND them, each quoted) rather than `searchEntries`' exact-phrase wrapping — loose keyword recall is the right behavior for the event tier.
  - **event_query** — metadata filter (since/until on filename-date, tag, status), newest-first.
  - **event_rebuild** — full rebuild of the separate events.sqlite via `indexEvents`.

## Validation

- typecheck `tsc --noEmit` clean.
- **AC3** keyword recall (term-AND), all returning the correct top event:
  - `phantom account 529` → event_20260606_claude-cli-phantom-accounts-529 (rank −22.41)
  - `compaction CJK token undercount` → the CJK-aware estimateTokens events
  - `3R rebuild reinstall restart` → the 3R deploy + definition events
- **AC4** `event_query(since=2026-06-08)` returns only in-range events, newest first; `NULLS LAST` keeps undated entries from sorting to the top.

## Note: phrase vs term-AND

Initial reuse of `searchEntries` returned zero hits for multi-word queries because it wraps input as an exact FTS5 phrase. Replaced with an inline term-AND query in the event_search handler. wiki_search keeps its phrase behavior (unchanged).

## Live-exposure caveat

The running specbase MCP server still advertises the OLD tool list (tools are enumerated at server start). event_search/event_query/event_rebuild become callable over MCP only after the server restarts/reloads — the underlying logic is proven directly here. No daemon restart performed (G4).

## Remaining

- P3-2 optional post-commit hook.
- Phase 4 AGENTS.md three-tier routing rule.
- Phase 5 MEMORY.md migration (classify → route → verify).
- Phase 6 gated destructive: retire EVENT_LOG_UNIFIED.md stub + empty MEMORY.md (G5).
