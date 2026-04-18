# Event: plan-builder skill launch (replaces planner)

**Date**: 2026-04-18
**Scope**: Skill infrastructure (repo-external: `~/projects/skills/plan-builder/`)
**Trigger**: User conversation converging on spec-centric lifecycle management + code-independent spec philosophy

## Summary

Launched `plan-builder` skill as successor to the legacy `planner` skill. Unified the `plans/` and `specs/` folder dichotomy into a single `specs/<slug>/` location driven by a seven-state lifecycle machine. Added mandatory sync checkpoints, per-part history, on-touch peaceful migration, code-independence gap analysis, and an optional SSDLC profile.

## What landed

Skill files (at `~/projects/skills/plan-builder/`, symlinked to `~/.claude/skills/plan-builder/`):

- `SKILL.md` — user-facing contract (~300 lines)
- `schemas/state.schema.json` — machine contract for `.state.json`
- 4 shared libs: `state.ts`, `state-inference.ts`, `ensure-new-format.ts`, `snapshot.ts`, `inline-delta.ts`
- 9 scripts: `plan-init`, `plan-state`, `plan-validate`, `plan-promote`, `plan-archive`, `plan-migrate`, `plan-gaps`, `plan-sync`, `plan-rollback-refactor`
- 8 templates: 5 core (`data-schema.json`, `test-vectors.json`, `errors.md`, `observability.md`, `invariants.md`) + 3 SSDLC (`threat-model.md`, `data-classification.md`, `compliance-map.md`)

Legacy planner skill:

- Marked deprecated (frontmatter + banner). `plan-init.ts` and `plan-validate.ts` retained so legacy `plans/<slug>/` packages stay functional until they are touched by plan-builder and peacefully migrated.

Dog-food migration:

- `plans/plan-builder/` migrated to `specs/plan-builder/` via the new `plan-migrate.ts`. This was the first real migration executed by the new skill, proving on-touch peaceful migration works end-to-end.
- Inferred state: `planned` (tasks.md had zero checked items).
- Snapshot preserved at `specs/plan-builder/.archive/pre-migration-20260418/`.

## Key architectural decisions

- **Single folder**: `specs/<slug>/` holds every artifact regardless of maturity; `archived` is a state, not a folder.
- **Seven states**: proposed → designed → planned → implementing → verified → living → archived.
- **Seven modes**: new / amend / revise / extend / refactor / sync / archive (plus internal `promote`, `migration`, `refactor-rollback`). Mode classification is objective (which artifact layer is affected), not subjective (small/medium/large).
- **State-aware validation**: `plan-validate` and `plan-promote` only check artifacts required for the target state, so partial plans never block early discussion.
- **Sync as mandatory checkpoint**: `beta-workflow` will invoke `plan-sync.ts` after every task checkbox toggle. Drift warns but does not block (warn strategy chosen over block or log-only).
- **On-touch peaceful migration**: any plan-builder script touching a `plans/<slug>/` path runs `ensureNewFormat()` which infers state, snapshots, moves (`git mv` when tracked, plain `mv` when untracked), and writes `.state.json` — all with `[plan-builder-migrate]` log prefix. No silent fallback; no modal prompt.
- **Three-layer history**: inline delta markers (amend/revise/extend), section-level supersede markers, and full refactor snapshots to `.history/refactor-YYYY-MM-DD/`.
- **Prompt + script architecture**: deliberately did NOT elevate to an MCP server; all state lives in repo files, all operations are stateless transforms, LLM+scripts cooperate without a daemon.

## Bug caught during dog-food

`plan-promote` originally validated the current state before writing the target state, which let `proposed → designed` succeed even when target-state artifacts were missing. Fixed by adding `--as-state=<state>` override to `plan-validate` and having `plan-promote` invoke with the target state. Dog-food migration would have hidden this; a separate smoke-test caught it.

Second bug: `ensureNewFormat()` tried `git mv` unconditionally, which fails for untracked source directories (the common case for brand-new plan packages). Fixed by probing `git ls-files` first and choosing between `git mv` (tracked files exist) and plain `mv` (no tracked files, nothing to preserve). Both branches log their rationale.

## Follow-ups

- **HLS skill (future)**: A separate skill called something like `hls-synthesizer` should sit between plan-builder's `designed` state and `beta-workflow`'s build execution. It will produce pseudo-code artifacts that bridge IDEF0/GRAFCET/C4 designs to implementation-ready blocks. Not in V1 scope; will be added via `plan-builder`'s own `extend` mode later — becoming the first real extend-mode demonstration.
- **beta-workflow integration (Phase 7 of plan)**: update `beta-workflow` skill to invoke `plan-sync.ts` after every task checkbox toggle and to read `tasks.md` from `specs/<slug>/` instead of `plans/<slug>/`.
- **Downstream skill sync**: `agent-workflow`, `miatdiagram`, `code-thinker` may still reference `/planner` or `/plans/` — audit and update in a batch.
- **Template registry**: `plan-init` currently only scaffolds `proposal.md` + `.state.json`. Extend it to scaffold state-appropriate artifacts when promoting (e.g., when promoting to `designed`, auto-copy the relevant templates into the spec folder).

## Plan at completion

`specs/plan-builder/` — state=planned, migrated from `plans/plan-builder/`. Remaining tasks per its own `tasks.md` are mostly Phase 7 (downstream sync) and Phase 8 (sync + per-part history extras). Skill is functional as of this launch event.
