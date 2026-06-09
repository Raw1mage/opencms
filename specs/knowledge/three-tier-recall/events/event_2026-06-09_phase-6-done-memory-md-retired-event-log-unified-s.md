---
date: 2026-06-09
summary: "Phase 6 done: MEMORY.md retired + EVENT_LOG_UNIFIED stubbed; new three-tier recall contract live"
---

# Phase 6 done: MEMORY.md retired + EVENT_LOG_UNIFIED stubbed; new three-tier recall contract live

## Destructive finalization (user-approved, gated last)

- **MEMORY.md**: 60983 → **1050 bytes** — replaced with a pointer to the three-tier recall model. 153 topic file bodies remain on disk AND are indexed (`memory/` slug prefix), so nothing is orphaned. Backed up to `$XDG_RUNTIME_DIR/claude-work/three-tier-recall/MEMORY.md.bak`.
- **EVENT_LOG_UNIFIED.md**: 543137 → **670 bytes** stub. Pre-flight found it is NOT git-tracked (docs/ is gitignored) — DD-8's "recoverable via git" was wrong — but its 144 source events all exist in `docs/events/archive/` and are FTS-indexed, so the content is duplicate. Backed up to XDG temp regardless.
- **Inline-only MEMORY sections** (Key Architecture, Hosts, Known Tech Debt, Multi-User) had no topic file → preserved into new `memory/reference_opencode_infra_and_techdebt.md` (indexed, findable). 2 stale inline sections (Freerun planned-state, plan-builder LAUNCHED) dropped — covered elsewhere.

## Routing landed

- `~/.claude/CLAUDE.md`: promoted the durable behavioral rules (don't-perform-honesty, don't-punt, plain-language, use-question-tool, Other-is-guidance, destructive-tool-guard, 大道至簡) + replaced the MEMORY hygiene section with the three-tier recall model.
- opencode `AGENTS.md` (committed 483fbb0c8): eager three-tier routing rule + Provisional + 3R term in daemon section.

## Acceptance evidence (final)

- AC1 events.sqlite: 1148 entries / 1148 fts.
- AC2: spec index byte-identical (22) — never touched.
- AC6: AGENTS.md routing rule 21 lines (≤25).
- AC7: retired knowledge still findable — `phantom account 529` → docs event; `rawbase rawdb` → memory/reference_opencode_infra_and_techdebt.
- AC8: UNIFIED stub 670 bytes.
- AC9: events.sqlite 12MB (≤35), ~1.7s rebuild.

## Commits

- specbase: b59b37d (separate index + MCP tools), 4596558 (external sources).
- opencode: 483fbb0c8 (AGENTS.md). docs/ + ~/.claude + memory dir are not opencode-tracked.

## Remaining

- P3-2 optional post-commit hook — deferred (CLI + event_rebuild already cover refresh).
- Live MCP exposure of event_* tools needs a specbase MCP reload + `SPECBASE_EVENTS_EXTRA` env for memory inclusion.
