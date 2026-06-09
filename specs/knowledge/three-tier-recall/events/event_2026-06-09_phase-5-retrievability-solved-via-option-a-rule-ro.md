---
date: 2026-06-09
summary: "Phase 5 retrievability solved via option A; rule-routing scope nuance surfaced"
---

# Phase 5 retrievability solved via option A; rule-routing scope nuance surfaced

## Decision

User chose **option A**: index the Claude Code memory dir as a third event source. Implemented in specbase (commit 4596558): `indexEvents.extraSources`, CLI `--memory-dir`, MCP `event_rebuild` reads `SPECBASE_EVENTS_EXTRA` env, frontmatter-parse fallback, MEMORY.md excluded.

## Result (the retrievability blocker is solved)

- events.sqlite now holds **1146 entries** = 992 repo events + **152 memory topic bodies** (prefixed `memory/`) + plans events. 0 errors, 1.6s, 9.8MB.
- Spec index byte-identical (22/22) — still isolated.
- Spot-check AC7: `event_search('CJK undercount drain')` → `memory/project_compaction_anchor_cjk_token_undercount` (the body that was NOT in docs/events) is now findable.
- All ~110 recall-bucket bodies are therefore retrievable; emptying MEMORY.md will no longer orphan them.

## Scope nuance found (needs a beat before promoting rules)

The manifest's "promote behavioral rules → AGENTS.md" is partly wrong on target. Per the memory entry `feedback_agents_md_not_for_claude`, **opencode's AGENTS.md governs opencode's runtime agent, not Claude Code**. So:
- **Repo-working rules** (XDG backup, daemon lifecycle, no-silent-fallback, PR-default) → AGENTS.md (mostly already there).
- **My conversational-behavior rules** (don't-perform-honesty, don't-punt, plain-language-over-function-names, use-question-tool) → belong in **~/.claude/CLAUDE.md** (my config), NOT opencode AGENTS.md.
- The three-tier routing rule already added to AGENTS.md is fine for both (both runtimes have the MCP tools and I read repo AGENTS.md).

## Remaining (gated)

- P5-2/3: route the ~8 behavioral rules to the CORRECT target (CLAUDE.md vs AGENTS.md), ~6 reference facts, and 3R→/3r skill.
- P5-4: verify list.
- Phase 6 (G5): retire EVENT_LOG_UNIFIED.md stub + empty MEMORY.md — still blocked pending user go.

## Note: live MCP exposure

For the live `event_rebuild` to include memory, the specbase MCP needs `SPECBASE_EVENTS_EXTRA` set (JSON `[{"root":"…/memory","globs":["*.md"],"slugPrefix":"memory"}]`) in its mcp config, and a server reload. The CLI rebuild already does it via --memory-dir.
