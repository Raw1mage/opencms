---
date: 2026-06-09
summary: "Transition strategy: old-format event logs need zero migration; new events enrich gradually"
---

# Transition strategy: old-format event logs need zero migration; new events enrich gradually

## The concern

All event logs across all projects are old-format (no YAML frontmatter, ad-hoc `Date:` lines). How is the transition handled?

## Answer: there is no migration event — the design absorbs the old format

1. **Format-agnostic indexing (zero migration).** `indexEvents` derives `created` from the **filename** (`YYYYMMDD` / `YYYY-MM-DD`) and full-text-indexes the whole body. So every old-format event — in any project — is immediately `event_search`-able. Old format degrades only to "full-text-only" (no `tag`/`status` *filter*), never to "unsearchable". No backfill is required or recommended (DD-3).

2. **Gradual enrichment going forward (DD-9).** New events SHOULD carry minimal frontmatter (`date` / `summary` / optional `tags` / `status`). The writer path already emits it: `spec_record_event` now writes `date`+`summary` and optional `tags`+`status`. Hand-written `docs/events` adopt the convention over time. The corpus enriches monotonically with no flag day.

3. **Multi-project rollout is the same engine, per-repo store.** The tools take a `repo` arg and `eventsDbPathFor(repo)` resolves `<repo>/.specbase/events.sqlite`, so one specbase MCP serves every project; each project gets its own event index by running `event_rebuild {repo}` (or `index-events <repo>`). No central migration, no cross-project coupling.

## Net

The transition is **gradual and non-disruptive by construction**: old events work today as-is; new events are richer; each project opts in by rebuilding its own index. The only per-project action is the first `event_rebuild`. This is recorded as the canonical transition stance for `knowledge/three-tier-recall`.

## This package's own status

Graduated to `living` (specs/knowledge/three-tier-recall). specbase commits b59b37d / 4596558 / d73e258; opencode AGENTS.md 483fbb0c8; spec package b2bb69fb9.
