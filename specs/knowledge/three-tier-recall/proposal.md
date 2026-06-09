# Proposal: knowledge_three-tier-recall

## Why

- The Claude Code per-project `MEMORY.md` (at `~/.claude/projects/-home-pkcs12-projects-opencode/memory/`) has grown to 52KB / 466 lines — **over the official 25KB / 200-line eager-load cap**. Entries past the cap fall into a dead zone: not eager-loaded (no discoverability) and not proper on-demand topic files (not retrievable). Worse than "write-only" — it is "written while pretending to be in the index."
- Every edit re-writes the resident head into the cached prefix at **cache-write cost (1.25×–2× base input)**, on Opus. The cost driver is write-churn, not read.
- Structurally, `MEMORY.md` is **a flat smear across a refinement gradient**. It simultaneously tries to be raw history, distilled decisions, and durable essence — excelling at none. Each content type has a better-fitting home that already exists or is one bounded change away.
- The ecosystem already has the right substrate: **session history is SQLite; specwiki (specbase) is a live SQLite FTS5 index.** Only the middle tier — the event log — is still 993 loose markdown files that can only be grep'd. Closing that gap completes a coherent three-tier architecture and lets `MEMORY.md` retire.

## Original Requirement Wording (Baseline)

- "把memory.md退役清空。與運作規則有關的部份改放到agents.md。已經是過去歷史決定的事放eventlog。"
- "為「eventlog」建立index/toc query 機制。我還不知道怎樣的方案最優最省資源。土法煉鋼就是叫agent使用grep tool，但這真的太土了"
- "specbase本身是精華中的精華，但eventlog本身是流水帳。我懷疑有必要混在同一個db嗎"
- "從訊息的粗到細來排：session log→event log→specwiki"

## Requirement Revision History

- 2026-06-10: initial draft created from a long design conversation; all core engineering decisions locked (DD-1..DD-6).

## Effective Requirement Description

1. **Index the event log** so past decisions/RCAs are retrievable by ranked full-text query instead of raw grep — reusing the specbase FTS engine but in a **separate store**.
2. **Wire three-tier retrieval** into AGENTS.md so the agent knows which tier to query for which granularity of need (closes the triggering/discoverability gap that indexing alone leaves open).
3. **Migrate and retire MEMORY.md**: route each entry to its correct tier/home, verify retrievability, then empty the file.

## Scope

### IN
- A **separate events index** (`events.sqlite`) built by reusing the specbase engine (`packages/lib`), with a flat-file event source (`docs/events/*.md` + `plans/**/events/*.md`), slug + created-date derived from filename, html render skipped.
- A **query surface** for events (`event_search` / `event_query`, or a `source:events` switch) distinct from the spec corpus.
- A **refresh trigger** (on-demand and/or post-commit hook).
- **AGENTS.md wiring**: a small eager three-tier routing rule + migration of operating-rule content out of MEMORY.md (with a `provisional` subsection for un-promoted behavioral preferences).
- **MEMORY.md migration + emptying** (destructive; gated last, after retrievability is verified).

### OUT
- Embedding / vector RAG (rejected — heaviest, least resource-efficient; FTS + filename-date covers the query patterns).
- Mixing events into the spec corpus / spec DB (rejected — BM25 IDF contamination).
- Mass-migrating the 912 frontmatter-less `docs/events` files (rejected — filename date + full-text body suffice).
- Incremental indexer (deferred — full rebuild is ~1–5s, acceptable; add mtime-incremental only if corpus growth demands).

## Non-Goals

- Changing how session history is stored (already SQLite; untouched).
- Re-curating spec content or altering spec search behavior (spec corpus must stay byte-for-byte unaffected — that is the whole point of the separate store).

## Constraints

- **Cross-repo**: the specbase engine lives in the separate repo `/home/pkcs12/projects/specbase/`. Engine changes are made there.
- **XDG backup**: per project CLAUDE.md, before the first code edit/test, back up the `~/.config/opencode/` whitelist files to `~/.config/opencode.bak-<YYYYMMDD-HHMM>-three-tier-recall/`.
- **Daemon lifecycle**: never self-spawn/kill/restart the daemon; only `webctl` / `system-manager:restart_self`.
- **PR default off** for this repo unless the user asks.
- **Destructive step ordering**: emptying MEMORY.md must be LAST and only after migrated content is verified findable through the new index.

## What Changes

- specbase engine gains a flat-file event-source ingestion path + a separate events DB target.
- A new events query tool/surface appears.
- AGENTS.md gains a three-tier retrieval routing rule and absorbs MEMORY.md's operating rules.
- MEMORY.md is emptied; `EVENT_LOG_UNIFIED.md` fate decided (see Open Decisions).

## Capabilities

### New Capabilities
- **Event-log full-text recall**: ranked BM25 snippets over 993 events, ms-scale, corpus-size-independent, returning ~KB of snippets instead of file dumps.
- **Three-tier routing**: explicit "how fine do I need it" → session / event / spec selection.
- **Drill-down / roll-up**: spec → its events (via `event_log` links) → raw session, without merging corpora.

### Modified Capabilities
- **Agent recall**: shifts from always-resident MEMORY.md tax + crude grep to on-demand ranked FTS across three tiers + a cheap eager pointer rule.

## Impact

- specbase repo (`packages/lib` indexer + `packages/mcp` query tools).
- opencode repo: AGENTS.md, possibly a post-commit hook, `docs/events/EVENT_LOG_UNIFIED.md` (retire/keep TBD).
- Claude Code memory dir: MEMORY.md + topic files (emptied/migrated).
- A new skill/command for the "3R" trigger-gated procedure (split out of MEMORY.md).

## Resolved Decisions (were open; user confirmed 2026-06-10)

- **EVENT_LOG_UNIFIED.md** → **retire** once the live index works; replace with a 2-line stub pointing at `event_search`, full content stays in git. (DD-8)
- **Going-forward event frontmatter** → **define a minimal convention for NEW events only** (`date/summary/tags/status`); leave the 912 existing files untouched. (DD-9)
