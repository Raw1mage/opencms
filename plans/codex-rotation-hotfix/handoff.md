# Handoff

## Execution Contract

- Build agent MUST read `implementation-spec.md` first.
- Build agent MUST read `proposal.md` / `spec.md` / `design.md` / `tasks.md` before coding, plus `specs/codex/provider-hotfix/` (sibling hotfix package) + `specs/architecture.md` (Provider Universe Authority section).
- Runtime todo MUST be materialized from `tasks.md` via `todowrite(mode=replan_adoption)` before coding begins.
- Build agent MUST NOT resume from discussion memory — this plan package is the execution contract.
- User-visible progress and decision prompts must reuse the planner-derived todo naming.

## Required Reads

- `proposal.md` (original wording + Effective Requirement Description)
- `spec.md` (GIVEN/WHEN/THEN per requirement)
- `design.md` (DD-1 through DD-10)
- `implementation-spec.md` (assumptions + stop gates + phase contract)
- `tasks.md` (phase-by-phase checklist)
- `../../specs/codex/provider-hotfix/README.md` (sibling codex hotfix; covers overlapping modules)
- `../../specs/architecture.md` (Provider Universe Authority section + Config Resolution Boundary from recent edits)
- `../manual-pin-bypass-preflight/plan.md` (precedent for honor-explicit-intent principle extended here to cross-provider boundary)

## Current State

- Plan validated via planner skill (10/10 artifacts pending final check).
- Main branch at `d4522077a` (webctl restart content-fingerprint smart-skip) — after codex provider-hotfix merge at `1ff8faeb6`.
- Nothing implemented on code side yet.
- No existing beta / test branches for this plan. A fresh `beta/codex-rotation-hotfix` worktree will be created by beta-workflow.

## Stop Gates In Force

- **Pre-coding audits (tasks 1.1/1.2, 2.1, 3.1, 3.6, 4.1)**: if the actual call-site shape differs from assumptions in `implementation-spec.md`, stop and re-plan. In particular if `Account.resolveFamily` is not the right helper, or if `wham/usage` rejects codex-subscription tokens, stop.
- **No cross-family side effects**: the cockpit extension must not change openai / gemini-cli / google-api / anthropic behavior.
- **No config flag for same-provider-only**: Phase 3 is hard-coded per DD-5. If tempted to add a `sameProviderOnly` config knob, stop.
- **Log line budget**: exactly one log line per decision branch (not per candidate). Don't spray log.info in 6-account pools.
- **Phase boundary validations**: do not advance a phase until its validation items in `tasks.md` pass.
- **Regression gate**: no new test failures vs pre-hotfix main baseline (5 pre-existing failures unchanged). Any new failure blocks commit.
- **AGENTS.md 第一條**: every new branch logs; silent swallow is never acceptable.

## Build Entry Recommendation

- Start with Phase 1 (cockpit extension) — smallest blast radius, single gate to widen, existing quota-fetch machinery reused.
- Phase 2 is orthogonal to Phase 1; can be done in parallel by the same agent on separate commits.
- Phase 3 has the highest risk (cross-module wiring, new error class, processor preflight audit); do it AFTER Phase 1 + 2 land and tests are green.
- Phase 4 is a tiny classification patch; can land anytime.
- Phase 5 (tests + docs + closeout) at the end.

## Execution-Ready Checklist

- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in `tasks.md`

## Completion / Retrospective Contract

- After build + test pass, compare implementation against the four Effective Requirements in `proposal.md` (codex cockpit, codex candidate filter, codex-family-only, observability).
- Produce a validation checklist: requirement coverage, gaps, deferred items, evidence.
- Do not expose raw internal chain-of-thought; auditable conclusions and evidence only.
- Each phase closes with an entry in `docs/events/event_2026-04-18_codex_rotation_hotfix.md` (updated as phases complete).
