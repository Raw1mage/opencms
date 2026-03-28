# Handoff

## Execution Contract

- Build agent must read `implementation-spec.md` first.
- Build agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Build agent must materialize `tasks.md` into runtime todos before coding.
- Build agent must preserve planner task naming in runtime progress.
- Build agent must implement `plan_enter` naming repair as a dedicated slice before broader trigger framework integration if planner-root drift is still present; first version scope is slug derivation only.
- Build agent must keep first-version behavior deterministic: no background AI classifier, no silent fallback, no in-flight tool hot swap.

## Required Reads

- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md
- specs/architecture.md

## Current State

- The active plan root was originally a wrong-slug template package and has now been repurposed as the authoritative planning surface for `dialog_trigger_framework`.
- Existing runtime evidence already supports per-round tool resolution and dirty-cache rebuild semantics.
- `plan_enter` naming drift is recognized as an explicit follow-up implementation slice, scoped to slug derivation in v1.
- User-selected v1 priorities are: must-have triggers = `plan_enter/replan/approval`, detector style = centralized registry, and `plan_exit` should wait until event + architecture are synced.

## Stop Gates In Force

- Stop if implementation would require in-flight hot reload or background AI governance in the first version.
- Stop if `plan_enter` naming repair changes planner lifecycle semantics beyond slug derivation / topic alignment.
- Stop if trigger behavior crosses beta workflow or architecture-sensitive boundaries without updated artifacts.

## Build Entry Recommendation

- Start by auditing `packages/opencode/src/tool/plan.ts` planner-root derivation and naming inputs.
- Then define a centralized trigger registry/policy surface that can feed `prompt.ts` and `resolve-tools.ts` at round boundaries.

## Execution-Ready Checklist

- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in tasks.md
