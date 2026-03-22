# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding.
- Materialize tasks.md into runtime todos before coding.
- Preserve planner task naming in user-visible progress and runtime todo.
- Add `plan_enter` overwrite protection first so active planner roots cannot be blindly reinitialized.
- Optimize the existing builder control plane instead of replacing it with a new execution model.
- Internalize beta workflow as builder-native deterministic behavior for routine git/worktree/commit/push/pull/runtime operations so AI remains focused on coding, debugging, and judgment-heavy work.
- Treat current beta/dev MCP surface only as temporary migration scaffolding; final user workflow must not depend on it.
- Preserve explicit question / approval gates for branch naming, runtime policy, dirty trees, validation blockers, and destructive finalize operations.

## Required Reads

- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md

## Current State

- Public beta-tool MCP exists and is validated as an independent worktree orchestration surface.
- `plan_exit`, mission metadata, workflow-runner, and runner contract already form the builder control plane.
- Current builder does not yet understand beta lifecycle stages end-to-end.
- Current `plan_enter` overwrite guard is too weak because it checks only `implementation-spec.md` existence before writing templates.
- User wants a conservative optimization: keep original builder capabilities intact, teach it beta workflow, reduce AI dependence for routine orchestration including commit/push/pull/checkout details, and eventually eliminate the need for beta/dev MCP in normal usage.

## Stop Gates In Force

- Stop if planner artifacts do not explicitly represent beta-loop execution, validation posture, and finalize posture.
- Stop if absorbed beta orchestration requires bounded clarification not yet captured in artifacts or user answers.
- Stop if `plan_enter` integrity checks still allow existing curated planner roots to be blindly overwritten.
- Stop if the proposed builder changes would regress or bypass legacy-compatible non-beta flow.
- Stop before merge / cleanup / worktree deletion execution; builder may prepare preflight, but destructive finalize still requires explicit approval.
- Stop before remote operations that policy marks as approval-required.
- Return to planning if implementation introduces a new workflow slice not represented in planner artifacts.

## Build Entry Recommendation

- Start by internalizing deterministic beta primitives from the current beta-tool logic, then extend `plan_exit` and mission metadata narrowly before modifying workflow-runner behavior.

## Execution-Ready Checklist

- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in tasks.md
