# Design: knowledge_three-tier-recall

## Context

The Claude Code per-project `MEMORY.md` has outgrown its eager-load cap and become a flat smear across what is really a three-tier refinement gradient (session log → event log → specwiki). Two of the three tiers are already SQLite-queryable; only the event log (993 loose markdown files) is grep-only. This work closes that gap by reusing the specbase FTS engine over a separate events store, wires three-tier retrieval routing into AGENTS.md, and retires MEMORY.md by routing its content to the correct tier.

## Goals / Non-Goals

**Goals**
- Make the event log retrievable by ranked full-text query (BM25), cheaply, without polluting the spec corpus.
- Close the triggering gap (agent knowing to query) via a small eager AGENTS.md routing rule.
- Retire MEMORY.md with every entry routed to its correct home and verified findable.

**Non-Goals**
- Embedding / vector RAG (rejected as least resource-efficient — DD-7).
- Mixing events into the spec DB (rejected — BM25 IDF contamination, DD-2).
- Mass-migrating 912 frontmatter-less files (rejected — filename-date + full-text suffice, DD-3).
- Changing session-history storage (already SQLite).

## Risks / Trade-offs

- **Full rebuild, no incremental** (~1–5s for 993 files). Accepted; add mtime-incremental only if corpus growth demands.
- **Filename-date dependence**: events whose filename lacks a parseable date get a null `created` and fall back to full-text only. Acceptable — date is present in all current filenames; the new-event convention (DD-9) hardens this going forward.
- **Cross-repo change**: the engine edit lands in `/home/pkcs12/projects/specbase/`, a different repo from opencode. Coordination/versioning risk.
- **Triggering still depends on the agent**: indexing solves retrieval, not the decision to query. Mitigated by the eager AGENTS.md rule (DD-6) but not eliminated.
- **Destructive emptying of MEMORY.md**: gated last, only after migrated content is verified findable; original recoverable from git/topic files.

## Critical Files

- `/home/pkcs12/projects/specbase/packages/lib/src/indexer.ts` — flat-file event source + separate-DB target (primary change).
- `/home/pkcs12/projects/specbase/packages/lib/src/schema.ts` — reused as-is.
- `/home/pkcs12/projects/specbase/packages/mcp/src/index.ts` — `event_search` / `event_query` tools.
- `/home/pkcs12/projects/opencode/AGENTS.md` — three-tier routing rule + migrated operating rules.
- `/home/pkcs12/projects/opencode/docs/events/EVENT_LOG_UNIFIED.md` — retired to a stub (DD-8).
- `~/.claude/projects/-home-pkcs12-projects-opencode/memory/MEMORY.md` — emptied last (DD-5).

## Architecture

### The refinement gradient (coarse → fine)

Three tiers ordered by degree of distillation. Volume falls, permanence rises, authority rises, and signal-density rises as you move from session → event → spec.

| Axis | session log | event log | specwiki |
|---|---|---|---|
| Refinement | raw ore (verbatim) | distilled (checkpoints/decisions/RCA) | essence (living, authoritative) |
| Volume | largest (firehose) | medium | smallest |
| Mutation | append-only, ephemeral | append-only, retained | continuously edited |
| Authority | "what happened" (raw fact) | "what was done / why" | "what the design is" (current truth) |
| Temporality | per-turn | chronological | timeless (concept) |
| Query role | forensic replay | chronological recall | conceptual reference |
| Store | **SQLite (exists)** | **build: events.sqlite** | **SQLite FTS5 (specbase, exists)** |

Two flows run along the gradient:
- **Distill upward (write)**: session → curate → event → crystallize → spec. (The promotion pipeline.)
- **Drill down (read)**: spec → its events (`event_log` links) → raw session (session-id refs). Stop at whatever granularity the need requires.

### Principle: share the engine, separate the store

specbase decomposes into **engine** (`packages/lib`: FTS5 schema, parser, indexer, query — reusable machine) and **corpus** (the 22 curated spec entries — a specific dataset). The event log reuses the engine but **must not** share the corpus/FTS table.

Hard reason (DD-2): FTS5 BM25 computes IDF and average-doclength over the entire FTS table. Folding 993 events (45× the spec count) into the 22-spec table reshuffles those statistics and degrades spec ranking. A query-time `WHERE type='event'` filter does **not** fix this — the inverted index and docsize stats are already contaminated. Separation is therefore *technically required* to preserve spec search quality, not merely aesthetic.

### Components

1. **Events indexer** — reuse `packages/lib` indexer with a new flat-file source:
   - glob `docs/events/*.md` (912) + `plans/**/events/*.md` (81)
   - slug + `created` derived **from filename** (date is always in the filename: `YYYYMMDD` or `YYYY-MM-DD`); body = whole file → FTS5
   - **skip body_html render** (dead weight for an agent-only recall store)
   - target a **separate DB**: `.specbase/events.sqlite` (same schema, different file)
2. **Events query surface** — `event_search` (BM25 full-text) + `event_query` (date / `type:event` filter), distinct from `wiki_search`/`wiki_query`. (Or a `source:events` switch routing to the events DB.)
3. **Refresh trigger** — on-demand tool + optional post-commit git hook; full rebuild ~1–5s.
4. **Cross-tier links** — keep existing `link_type='event_log'` edges (spec → event) so drill-down works without merging corpora.
5. **AGENTS.md three-tier routing rule** — small eager pointer encoding which tier to query for which granularity; closes the agent-passivity/triggering gap.
6. **MEMORY.md migration** — taxonomy-based routing of every entry, then empty the file (last).

### MEMORY.md retirement taxonomy

| Content type | Home | Rationale |
|---|---|---|
| Operating RULE (binding, every-turn) | AGENTS.md | eager, authoritative; applies each turn — worth the resident cost |
| Behavioral preference, un-promoted | AGENTS.md `## Provisional` | staging area; promote/demote by editing |
| Historical / RCA / DECISION | event log (mostly already in git+events) | retrieval problem → solved by the index; redundant copies deletable |
| Trigger-gated PROCEDURE (e.g. "3R") | skill / command | binding + authoritative + dormant-zero-cost = the definition of a skill |
| High-churn state | not stored | belongs in plans / `.state.json` / events |

## Decisions

- **DD-1**: Model session→event→spec as a single **refinement gradient** (coarse→fine), not three peer stores. Three separate stores, one shared FTS engine, graph-link connectivity; write distills upward, read drills downward. This gradient is the architecture that replaces MEMORY.md's flat smear.
- **DD-2**: Reuse the specbase engine but build a **separate `events.sqlite`**, never mixing events into the spec FTS table. Reason: BM25 IDF/doclength contamination degrades spec search and a query-time filter cannot undo it. Share engine code, separate corpus.
- **DD-3**: Ingest events via **flat-file glob** with **slug + date derived from filename**; skip html render; **do not** mass-migrate the 912 frontmatter-less files. Filename date + full-text body covers the dominant query patterns at zero migration risk.
- **DD-4**: Preserve cross-tier connectivity via the **existing `link_type='event_log'` edges** (spec→event). Drill-down from essence to raw works through links, not corpus merge.
- **DD-5**: Retire MEMORY.md by **routing each entry through the taxonomy** (rule→AGENTS.md, history→event log, procedure→skill, churn→nothing), then **emptying it last**, only after migrated content is verified findable through the index. Destructive step is gated.
- **DD-6**: Add a small **eager three-tier routing rule** to AGENTS.md. Indexing solves *retrieval* but not *triggering* (the agent must know to query); the eager pointer closes that gap cheaply, reserving the resident tier for routing logic only, not knowledge.
- **DD-7**: Reject embedding/vector RAG and reject raw-grep. FTS5+BM25 is the resource floor that still beats grep (ranking, snippets, ms queries, no model cost); embeddings are the least resource-efficient option and unnecessary for this corpus.
- **DD-8**: Retire EVENT_LOG_UNIFIED.md once the live events index is working — it is a 531KB hand-maintained file covering only 144/912 events with no generator (a stale, failed manual precursor of this very index). Replace it with a 2-line stub pointing at the event_search tool; the full content remains recoverable in git.
- **DD-9**: Define a minimal YAML frontmatter convention (date / summary / tags / status) for NEW events only; leave the 912 existing frontmatter-less docs/events files untouched. The index gets progressively richer tag/status filters over time at zero migration risk, while old events remain fully covered by filename-date plus full-text body.

## Code Anchors

(to be filled during implementation — specbase repo)
- `/home/pkcs12/projects/specbase/packages/lib/src/indexer.ts` — add flat-file event source + separate-DB target
- `/home/pkcs12/projects/specbase/packages/lib/src/schema.ts` — reuse as-is (events fit existing schema)
- `/home/pkcs12/projects/specbase/packages/mcp/src/index.ts` — add `event_search` / `event_query` tools
- `/home/pkcs12/projects/opencode/AGENTS.md` — three-tier routing rule + migrated rules

## Event log

- See `events/` for implementation records.

## Submodule references

- specbase engine: `/home/pkcs12/projects/specbase/` (separate repo, cross-repo change).
