# Handoff: autonomous-opt-in

## Execution Contract

The executor (human or AI agent) implementing this spec MUST:

- Treat `tasks.md` as the canonical execution ledger; update checkboxes in real-time per plan-builder §16.3
- Materialize **only the current phase's** unchecked items into TodoWrite at any moment; do not batch the whole file
- Run `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/autonomous-opt-in/` after every checkbox toggle; honor drift warnings per §16.3 decision tree
- Keep `.state.json.state` consistent with progress (`planned → implementing` on first `- [x]`, `implementing → verified` when all checked + validation captured)
- **Never** introduce the "always-on" behavior back during incremental work — even a temporarily-always-on intermediate state regresses the observed symptom
- **Never** silently fall back if a lookup fails (missing binding, missing `.state.json`, misparsed phrase) — always `log.warn` + surface per AGENTS.md 第一條

## Required Reads

Before touching any code, the executor MUST have read and understood:

1. [proposal.md](proposal.md) — the six R-rules and design-spiral history
2. [spec.md](spec.md) — GIVEN/WHEN/THEN scenarios for all seven R-requirements
3. [design.md](design.md) — decisions DD-1..DD-10, risks, critical files
4. [idef0.json](idef0.json) + [grafcet.json](grafcet.json) — functional decomposition (A1-A6) and state machine (idle ↔ armed ↔ disarm/demote paths)
5. [c4.json](c4.json) — component boundaries, especially C1-C12 ownership and relationships
6. [data-schema.json](data-schema.json) — Storage key shapes, tweaks.cfg keys, Bus event schema
7. [specs/architecture.md](../architecture.md) — global runloop architecture (the modification surface)
8. `packages/opencode/src/session/workflow-runner.ts` — the three "always-on" call sites to replace
9. `~/.claude/skills/plan-builder/SKILL.md` §16 — execution contract during `implementing`
10. `AGENTS.md` 第零條 + 第一條 — plan-first + no-silent-fallback constraints

## Stop Gates In Force

Stop immediately and request approval / decision if any of the following occurs during execution:

- **SG-1** Decision needed on an Open Question (OQ-1..OQ-5 in proposal.md) that wasn't resolved during `designed` review
- **SG-2** Proposed refactor touches files outside the Critical Files list in design.md (scope creep)
- **SG-3** A test fails that suggests the existing armed-path semantics would regress (this spec must NOT change armed behavior)
- **SG-4** plan-sync.ts warns with drift > 3 files — investigate before continuing
- **SG-5** MCP `question` tool is not available in the executor's environment — execution of Phase 3 pauses; executor asks user how to handle
- **SG-6** Any destructive action on user data (accounts.json, session storage, spec folders) proposed but not requested by user
- **SG-7** Any `bun test` run wipes or risks wiping XDG state — per [feedback_beta_xdg_isolation.md](~/.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_beta_xdg_isolation.md), beta-workflow MUST isolate via `OPENCODE_DATA_HOME` before running tests

## Execution-Ready Checklist

Before starting Phase 1:

- [ ] `.state.json.state` is `planned` (this spec)
- [ ] All artifacts in §Required Reads have been read
- [ ] Executor has a clean working tree (no uncommitted changes to the affected files)
- [ ] If using beta-workflow: implementation worktree created per beta-workflow skill contract; beta branch isolated from main
- [ ] `bun test` baseline captured (pre-implementation pass count) for regression comparison
- [ ] `plan-sync.ts specs/autonomous-opt-in/` currently reports `clean` (so any drift detected during implementation is attributable to the current work)

Before promoting `implementing → verified`:

- [ ] All `- [x]` in tasks.md
- [ ] Full `bun test` suite passes; diff against baseline shows only intended test additions
- [ ] Manual verification 8.2-8.4 documented in `docs/events/event_<date>_autonomous_opt_in.md`
- [ ] `plan-sync.ts` final run reports `clean` or drift explicitly reconciled via `amend` mode
- [ ] No new `// autonomous is always-on` comments or similar short-circuits exist anywhere in the codebase
- [ ] Turn-end latency in chat sessions verified < pre-change baseline (or explicit waiver documented with reason)
