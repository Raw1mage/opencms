---
name: plan-builder
description: Build, evolve, graduate, and archive specification packages across two zones (`/plans/<category>_<topic>/` for drafting, `/specs/<category>/<topic>/` after the user-triggered graduation gate). Driven by a seven-state lifecycle (proposed → designed → planned → implementing → verified → living → archived) and eight modes (new / promote / graduate / amend / revise / extend / refactor / sync / archive). Use when users need to plan new features, evolve living specs, or produce SSDLC-compliant change evidence. Pairs with the specbase MCP server (plan_create / plan_advance / plan_graduate / spec_amend / spec_tick_task / spec_record_event / spec_record_decision / spec_add_code_anchor / plan_archive / spec_sync / spec_translate / wiki_list / wiki_get / wiki_search / wiki_query / wiki_graph / wiki_validate / wiki_rebuild_index / plan_check) so the KB stays in sync as a side-effect of normal plan work.
---

# Skill: plan-builder

中文：**計畫建造器**；口語：**開 plan / plan skill**。

One folder per topic. One README index that mirrors the source files. One lifecycle the topic moves through. Wiki / KB / Quartz stay current automatically.

## 1. Conceptual model

**Spec is the unit. Plan is a stage name.**

A spec exists from the moment `plan_create` runs and lives through every subsequent state. We call it a *plan* when it's still in `proposed` / `designed` / `planned` (草稿期) for ergonomic reasons — that's what the plan-builder skill is for. Once the spec is being implemented, it's no longer "a plan", but it's still the same spec under a different lifecycle label.

Tooling reflects this taxonomy:

- **`plan_*`** — operates on a draft package: `plan_create` / `plan_advance` / `plan_archive` / `plan_check`. State-machine concerns.
- **`spec_*`** — operates on a spec's *interior* at any maturity: `spec_amend` / `spec_tick_task` / `spec_record_event` / `spec_record_decision` / `spec_add_code_anchor` / `spec_sync`. Content mutation.
- **`wiki_*`** — operates on the spec collection as a knowledge base: `wiki_list` / `wiki_get` / `wiki_search` / `wiki_query` / `wiki_graph` / `wiki_validate` / `wiki_rebuild_index`. Read-side / consumption.
- **`spec_translate`** — two-phase i18n bridge. AI works in source language (default English); the synthesised README index is mirrored as `README.en.md`; `spec_translate` projects it into the user's primary language (default `zh-Hant`) at `README.md`. Phase 1 returns the source body for AI to translate inline; phase 2 saves the translation. specbase MCP itself does no LLM call — translation happens in the AI's own conversation context (DD-16: LLM via opencode).

The `plan-builder` skill name is preserved (system-prompt continuity); semantically it would be `spec-builder` — but `plan` is the user's natural verb for "let's start a new spec", so the contracted form stays.

## 2. Philosophy (the DNA)

This skill is the union of three methodologies:

- **OpenSpec lifecycle**: proposed → designed → planned → implementing → verified → living → archived. Each state has required artifacts; transitions are gated.
- **IDEF0 functional decomposition**: every spec carries `idef0.json` (+ rendered `idef0.*.svg`) describing what the topic does, ICOM-decomposed.
- **GRAFCET runtime behaviour**: every spec carries `grafcet.json` (+ rendered `grafcet.svg`) describing how the topic evolves at runtime.

These three are **load-bearing** — they're what makes the spec a spec rather than a wiki page. Don't drop any of them when refactoring or simplifying.

Other principles:

- **Spec is product, code is derivative.** Aim for 80% spec effort, 20% codegen.
- **Plan and wiki are the same artifact at different maturity states.** README.md is auto-generated as an index; it reflects the source files (proposal.md / design.md / tasks.md / events/*.md / .state.json / idef0.json / grafcet.json).
- **Every change goes through the spec.** Including bug fixes. Sync mandatory. See §17.
- **Stage-3 sync is conversation-native.** Don't switch into "documentation mode" — call MCP tools mid-debug as you work. See §8.
- **History per part, not just per state machine.** Three layers: inline delta markers, section-level supersede, full snapshot. See §7.
- **On-touch peaceful migration.** Legacy `plans/<slug>/` auto-upgrades on first touch. See §9.
- **MCP for execution, prompts for judgment.** The plan-builder MCP server holds 17 tools; this skill teaches when to use which.

## 2. Use this skill when

- User asks to plan / spec / design any work before implementing (`開 plan`, `write a spec`, `plan this feature`)
- User discovers a bug or new idea mid-implementation and needs to reconcile it with the plan (amend / revise / extend / refactor mode)
- User wants to check / promote / archive a plan, or scan for code-independence gaps
- User touches a legacy `plans/<slug>/` folder
- User needs SSDLC-compliant change evidence
- Any task with multi-file / architectural / phased / regulated impact

## 3. Folder structure

A spec lives in one of two zones depending on lifecycle stage:

```
DRAFT zone (proposed → designed → planned → implementing → verified)
  /plans/<category>_<topic>/        ← flat underscore folder, no date prefix

KB zone (living, archived)
  /specs/<category>/<topic>/         ← semantic subdirectory, KB-visible
```

AI calls every tool with a slash-form slug (`compaction/codex-empty-turn`); the MCP encodes it for the active zone (`/plans/compaction_codex-empty-turn/` while drafting, `/specs/compaction/codex-empty-turn/` after graduation). Same package, regardless of zone:

```
<package>/
├── proposal.md       — Why / Effective requirements / Scope (proposed state)
├── design.md         — Architecture / Decisions (DD-N) / Code anchors / Submodule refs (designed+)
├── tasks.md          — Implementation checklist (planned+)
├── idef0.json        — IDEF0 functional decomposition (designed+)
├── idef0.*.svg       — drawmiat-rendered IDEF0 diagrams
├── grafcet.json      — GRAFCET runtime behaviour (designed+)
├── grafcet.svg       — drawmiat-rendered GRAFCET diagram
├── events/           — events/event_<date>_<slug>.md (created during implementing)
├── .state.json       — Lifecycle state + history (single source of truth)
└── README.md         — AUTO-GENERATED index (do not edit; mirrors the rest)
```

The `verified → living` transition (`plan_graduate`) physically moves the folder from /plans/ to /specs/. This gate is **manual only — user-triggered**; AI may report readiness but must not call `plan_graduate` itself (see AGENTS.md zone contract). Once graduated, all subsequent `amend` / `revise` / `extend` / `refactor` stay in /specs/ — no return to /plans/.

## 4. Lifecycle states

| State | Means | Required (in addition to lower-state requirements) |
|---|---|---|
| `proposed` | Initial why / scope captured | proposal.md + .state.json |
| `designed` | Architecture + contracts decided | + design.md, idef0.json, grafcet.json |
| `planned` | Tasks broken down | + tasks.md, handoff.md |
| `implementing` | Build in progress | tasks partially checked |
| `verified` | Tests + evidence pass | all tasks checked + validation evidence |
| `living` | Merged to main; spec = current code | same as verified, kept current via sync |
| `archived` | Frozen, read-only | same as living, frozen |

`wiki_validate` checks the artifacts required for the current state only; it does not block on missing future-state artifacts.

## 5. Modes (transition kind)

| Mode | Allowed transition | Use |
|---|---|---|
| `new` | (none) → `proposed` | Brand-new spec (creates package in /plans/) |
| `promote` | N → N+1 forward (within draft zone) | Natural advance: proposed→designed→planned→implementing→verified |
| `graduate` | `verified` → `living` | **User-only gate.** Move /plans/<flat>/ → /specs/<cat>/<topic>/, enter KB |
| `amend` | `living` → `living` | Bug fix within existing requirements (stays in /specs/) |
| `revise` | `living` → `designed` | Scope adjustment (stays in /specs/) |
| `extend` | `living` → `designed` | New requirement / capability (stays in /specs/) |
| `refactor` | `living` → `proposed` | Architecture-level rewrite, auto-snapshot to `.history/` (stays in /specs/) |
| `sync` | same-state | Reconcile code drift (warn-strategy, non-blocking) |
| `archive` | `living` → `archived` | Feature retired (stays in /specs/) |

Mode is classified objectively by the kind of change (code-only → no plan-builder action; Decision text edit → `amend`; new Phase → `revise`; new `### Requirement:` → `extend`; data-schema break → `refactor`), not by subjective small/medium/large judgment.

## 6. Stage-by-stage MCP tool playbook

The plan-builder MCP server exposes 17 tools. This is the conversational rhythm:

### Stage 1 — 構思 (Conception)

```
User: "I want to do X"
AI: discusses requirement, scope, constraints
AI: plan_create(slug, title)                          ← creates proposed-state package
AI: spec_record_decision(slug, "DD-1: ...")           ← capture key decisions inline
AI: wiki_query("fan-in:Y")                            ← surface related specs in conversation
```

When ready to advance:

```
AI: plan_advance(slug, to: "designed", reason: "...")
```

Plan-builder gates this transition: design.md, idef0.json, grafcet.json must exist. If missing, the call fails with a clear error — author them via miatdiagram skill (for IDEF0 / GRAFCET) and design.md (for architecture + decisions), then retry.

### Stage 2 — 實作 (Implementation)

```
AI: plan_advance(slug, to: "implementing")
AI: writes code...
AI: spec_tick_task(slug, match: "M1-3 schema runner")  ← incremental progress
AI: spec_add_code_anchor(slug, path: "packages/.../foo.ts", line: 42, symbol: "Bar")
... loop ...
AI: plan_advance(slug, to: "verified")
```

### Stage 3 — 維運 (Operation / debug / hotfix) — **conversation-native sync**

This is the stage where users historically forget to update plans. Don't.
**Whenever you touch the spec's domain in conversation, call the relevant tool.**

```
User: "I see a bug — the cache rotation breaks under contention"
AI: investigates ...
AI: spec_record_event(slug, summary: "cache rotation fails on contention",
                            body: "RCA: ... fix: ...")           ← capture immediately
AI: spec_record_decision(slug, "DD-N: rotate via lock token, not optimistic CAS")
AI: writes the fix ...
AI: spec_amend(slug, reason: "fix cache rotation contention bug")  ← marks the amend in history
AI: wiki_query("fan-in:cache-rotation")                            ← if other specs cite this, follow up
```

When debug discovers a scope shift:

```
AI: plan_advance(slug, mode: "revise", reason: "scope expanded to cover ...")
```

### Stage 4 — 知識化 (Knowledge / living)

```
AI: plan_advance(slug, to: "living")
```

Nothing else. The README.md has been current the whole time; Quartz already shows the topic; KB already serves it.

### Read tools (any stage)

```
wiki_list, wiki_get, wiki_search, wiki_query (DSL), wiki_graph,
wiki_validate, wiki_rebuild_index, plan_check
```

Use freely. They're cheap.

## 7. History — per part, not just state-machine

Three layers (carried unchanged from previous plan-builder version):

1. **Inline delta markers**: when `amend` / `revise` / `extend` modifies a Requirement / Scenario, prefix the changed line with strikethrough + `(vN, ADDED YYYY-MM-DD)` so the original wording stays visible.
2. **Section-level supersede**: Decisions that are replaced get `[SUPERSEDED by DD-N]` tags; both old and new entries kept in design.md.
3. **Full snapshot**: `refactor` mode auto-snapshots all artifacts (except proposal.md) to `specs/<slug>/.history/refactor-YYYY-MM-DD/` and resets to `proposed`-stage skeleton; `plan-rollback-refactor.ts` reverses this.

The .state.json.history array is the audit trail; every plan_advance / spec_amend / spec_sync appends one row.

## 8. Stage-3 sync discipline (most-violated rule)

The user's frustration: during fast iteration, AI often forgets to call spec_record_event / spec_amend etc. — they batch all docs at the end.

Don't. Each of these is a single conversation-native tool call:

| Conversation moment | Tool to call |
|---|---|
| "Found a bug" | `spec_record_event` |
| "Fixed the bug" | `spec_record_event` (RCA + fix), then `spec_amend` |
| "Decided to do X instead of Y" | `spec_record_decision` |
| "Wrote new function `Foo` at line N" | `spec_add_code_anchor` |
| "Marked task M-3 done" | `spec_tick_task` |
| "Scope changed" | `plan_advance` with mode=revise/extend |

The cost is one tool call (≤1s). The benefit is the README index stays current — Quartz auto-shows it, miatrag KB query returns it, no end-of-day "go back and document" tax.

## 9. On-touch peaceful migration

`ensureNewFormat(path)` is idempotent. On first touch of a legacy `plans/<slug>/`:

1. `inferState(path)` from artifact combination (deterministic table; no silent default — `StateInferenceError` on ambiguous cases per AGENTS.md rule 1)
2. Snapshot `cp` to `specs/<slug>/.archive/pre-migration-YYYYMMDD/`
3. `git mv plans/<slug>/ specs/<slug>/` (preserves history)
4. Write `.state.json` with inferred state + `migration` history entry
5. Log every step prefixed `[plan-builder-migrate]`

Triggered automatically by every plan-builder write tool when the target path is a legacy `plans/<slug>/`.

## 10. SSDLC profile (optional)

Some specs (security-relevant, regulated) need extra evidence:

- `proposal.md` includes data classification + threat model
- `design.md` includes compliance map
- `events/` records security review milestones
- `.state.json.profile` lists `["ssdlc"]`

`plan_create(slug, profile: "ssdlc")` opts in. Validation gates the extra artifacts at each state.

## 11. Sub-package convention

Sub-packages (e.g. `compaction/working-cache/`, `harness/autonomous-opt-in/`) get full lifecycle of their own:

- `specs/<parent>/<child>/` is treated by all tools as an independent topic with slug `<parent>/<child>`
- Parent README's `## Sub-packages` section auto-lists children
- Cross-link queries (`fan-in:`/`fan-out:`) traverse parent ↔ child

## 12. plan-validate gates

| At promote to | Must exist |
|---|---|
| designed | proposal.md (with required sections) + design.md + idef0.json + grafcet.json |
| planned | + tasks.md + handoff.md |
| implementing | (no new requirements) |
| verified | all tasks checked + validation evidence |
| living | (no new requirements; warns if drift detected via wiki_validate) |
| archived | (no new requirements) |

Failed validation is non-destructive — the call returns errors; you fix the artifacts and retry. plan_check pre-flights without making changes.

## 13. Drift detection

`wiki_validate` (works any state) reports:

- broken_links — internal cross-link target missing
- missing_back_links — A→B without B→A among related/sub_package/known_issue/inline
- orphans — entries with no in/out edges
- drift_code_anchors — `path:line` anchors where the file is gone or shorter than the line
- drift_submodules — `pinned_commit` metadata vs `git submodule status`
- drift_mermaid_clicks — `click X "url"` directives whose URL doesn't resolve

Drift is **warn-strategy** for the lifecycle (sync history records it but doesn't block). Use it diagnostically: drift surfacing during a session is a hint to call spec_amend.

## 14. CLI fallback

If MCP is unavailable, the underlying bun scripts still work:

```
bun ~/.config/opencode/skills/plan-builder/scripts/plan-init.ts <slug>
bun .../plan-promote.ts <path> --to <state> [--mode <mode>] [--reason "..."]
bun .../plan-sync.ts <path>
bun .../plan-validate.ts <path>
bun .../plan-archive.ts <path> [--move-to-archive-folder]
bun .../plan-rollback-refactor.ts <path>
bun .../plan-state.ts <path>      ← prints current state
bun .../plan-gaps.ts <path>       ← code-independence readiness report
bun .../plan-migrate.ts <path>    ← explicit legacy-path migration
```

The README sync hook fires from any of these CLI invocations the same way as from the MCP — `lib/miatrag-hook.ts` is shared.

## 15. Architecture documentation flow

For specs that span multiple sub-systems, also update `specs/architecture.md` (the cross-cutting index) — usually as part of the `living` transition. The architecture doc has its own `## Architecture Sync` checkpoints.

## 16. Three-skill division of labor

- **plan-builder** (this skill) — lifecycle execution + judgment + specbase MCP tool playbook
- **miatdiagram** — formal modelling (IDEF0 / GRAFCET; backed by drawmiat MCP)
- **(retired) specwiki** — absorbed into plan-builder; no longer needed

When the user asks for IDEF0 / GRAFCET stubs or rendering: hand off to miatdiagram skill. plan-builder's job is to ensure the artifacts exist when they need to (designed+ state).

Repo-level discipline (commit gate, event log filename pattern, graduation ownership) lives in the host repo's `AGENTS.md` zone contract; this skill defers to it rather than duplicating those rules.

## 17. Bug-fix routing (always-revise rule)

Before drafting any patch, locate the owning spec (graduated specs live in `/specs/`; `wiki_*` queries see only those). Run:

```
wiki_query("fan-in:<area>")
wiki_search("<symptom keywords>")
```

Find the spec that owns the affected behaviour. Open `revise` (or `amend` for in-bounds fixes). Carry the canonical spec's invariants forward. Then draft the patch.

Without this routing, debug agents (especially subagents with cold context) reason from local symptom evidence and silently break global guarantees.

## 18. Reading the README

`<repo>/specs/<slug>/README.md` is **auto-generated**. It carries `auto_generated: true` in frontmatter and a "do not edit" blockquote at the top. Edit the source files (proposal.md / design.md / tasks.md / events/*.md). The next plan-builder action regenerates the README.

If you find yourself wanting to edit README directly: that's a smell. Either:
- The change belongs in design.md (decisions / code anchors / architecture)
- The change belongs in tasks.md (progress)
- The change belongs in events/ (debug / hotfix records)
- The promote.ts synthesis is missing your section — open an issue / fix promote.ts

## 19. Why this DNA matters

OpenSpec gives the lifecycle skeleton. IDEF0 makes the system's static structure inspectable (what does this *do*, decomposed). GRAFCET makes the system's runtime behaviour inspectable (what *happens* over time). Without one of these three, the spec degrades into:

- only OpenSpec → schedule-tracking with no architectural truth
- only IDEF0 → static blueprint with no behaviour or lifecycle
- only GRAFCET → runtime model with no structure or progress

Together they form a spec that's executable (plan-builder), inspectable (Quartz wiki + miatrag KB), and verifiable (drift detection). Don't drop one to make the workflow lighter.
