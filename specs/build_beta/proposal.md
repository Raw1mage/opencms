# Proposal

## Why

- Builder already has a hardcoded control plane, but it does not currently understand beta development workflow end-to-end.
- The goal is not to replace builder, but to optimize its flow so it can follow beta development stages while delegating routine deterministic operations to built-in tooling instead of AI reasoning.
- This should reduce token usage, reduce repeated user prompting for git operations, and avoid workflow drift while preserving the builder capabilities that already exist.
- Long-term, users should not need a separate beta/dev MCP at all because the capability should live directly inside builder.

## Original Requirement Wording (Baseline)

- "現在beta tool以mcp的型式實作。但我希望在工作流程中和plan_exit所啟動的build mode結合成一條龍，也就是當planner問我要不要開始build的時候，就自動走beta-tool原本在做的流程。"
- "需求描述：把beta tool會做的開beta branch→實作→syncback回main repo→測試無誤merge這個流程內化在builder裏。"
- "如果builder已有硬編碼，那就是優化它，讓它知道要遵循beta tool的工作流程。"
- "原則上只是單純調整流程，讓它：1.懂得beta開發流程 2.善用相關工具減少Ai依賴。"
- "我想像的最終效果，就是我再也不需要每次都返覆的寫prompt要求AI要去commit, push pull branch checkout等細節命令。只要進入build，就自動在一個不影響主線但是基於主線的新分支寫程式，寫完可以整個分支拉回來主repo讓我測試並決定要不要merge。"
- "是的。最終我們就不再需要mcp dev-tool，因為上述能力內建在硬編碼builder裏"

## Requirement Revision History

- 2026-03-21: identified that builder already has hardcoded build-entry/runtime surfaces instead of being prompt-only.
- 2026-03-21: requirement converged on optimizing the existing builder rather than inventing a separate builder control system.
- 2026-03-21: user emphasized backward compatibility: preserve existing builder capabilities and only adjust flow so it knows the beta workflow and uses tools to reduce AI dependence.
- 2026-03-21: user clarified the final UX target: entering build should automatically handle routine branch/checkout/commit/push/pull details on a safe beta branch/worktree and return a testable branch to the main repo before merge approval.
- 2026-03-21: final steady state clarified: external `mcp dev-tool / beta-tool` should no longer be required once builder-native workflow is complete.
- 2026-03-21: discovered `plan_enter` anti-clobber gap: current implementation can recreate template artifacts too aggressively when only `implementation-spec.md` is missing, so overwrite protection must be added in the same change set.

## Effective Requirement Description

1. Preserve the current builder control plane and avoid breaking existing non-beta build behavior.
2. Teach builder to follow the beta workflow: create/reuse beta branch/worktree from the mainline, implement there, handle routine branch/checkout/commit/push/pull defaults, sync back to main for testing, then enter merge preflight.
3. Keep merge and cleanup approval-gated even when builder owns the lifecycle.
4. Move routine git/worktree/runtime operations into deterministic builder-owned tools or primitives so AI is not spending tokens re-planning repetitive steps and the user does not need to keep restating them.
5. Reuse beta-tool logic only as a migration source; the final steady state is builder-native capability with no required external beta/dev MCP.

## Scope

### IN

- Builder flow optimization on top of current hardcoded entry/runtime surfaces.
- Shared/absorbed beta orchestration logic reuse.
- `plan_exit` beta-aware bootstrap.
- Build-mode commit/push/pull defaults for routine execution.
- Build-mode syncback-based validation.
- Builder-owned merge preflight with explicit approval gate.
- Migration/deprecation path for beta/dev MCP.
- Regression protection for existing builder behavior.
- `plan_enter` overwrite protection for existing planner roots.
- Documentation and architecture sync for the workflow change.

### OUT

- Replacing builder with an entirely new MCP-first execution system.
- Auto-merge or auto-cleanup without explicit approval.
- New hidden fallback behavior for ambiguous branch/runtime decisions.
- Keeping external beta/dev MCP as the intended long-term user-facing control plane.
- Unrelated feature changes to existing builder capabilities.

## Non-Goals

- Rewrite build-mode runtime from scratch.
- Remove current planner/build mission semantics.
- Introduce browser/E2E automation as part of beta-flow optimization.

## Constraints

- Existing builder functions must remain intact unless an explicit regression-safe adjustment is required.
- The system must stay fail-fast and question-driven; no silent guesses.
- This repo must still honor `webctl.sh` as the runtime adapter, but the absorbed beta flow must stay project-aware.
- Merge/destructive actions must remain explicit approval-gated operations.
- Routine git operations should become builder defaults where policy allows, so the user does not need to repeatedly prompt for them.

## What Changes

- Builder gains awareness of beta lifecycle stages without losing its current execution-control responsibilities.
- `plan_enter` gains planner-root integrity checks so existing non-template artifacts are reused or blocked from accidental overwrite.
- Shared beta orchestration is absorbed into builder-owned deterministic behavior so routine orchestration shifts away from AI token-heavy reasoning and repeated prompt instructions.
- Planner/build handoff metadata is extended so beta-aware execution can flow through existing builder runtime surfaces.
- Build-mode validation and finalize stages become beta-aware while preserving current stop-gate discipline.
- Builder now owns more of the routine branch/checkout/commit/push/pull path, while still pausing at explicit approval boundaries.
- Beta/dev MCP becomes a temporary migration artifact and is deprecated for the final steady-state workflow.

## Capabilities

### New Capabilities

- builder-beta-bootstrap: existing builder can enter build mode through beta worktree bootstrap.
- builder-routine-git-flow: existing builder can own routine branch/checkout/commit/push/pull orchestration through deterministic built-in primitives.
- builder-beta-validation: existing builder can perform syncback-oriented validation using shared runtime policy.
- builder-beta-finalize-preflight: existing builder can prepare approval-gated merge/cleanup actions after successful validation.
- builder-native-beta-workflow: users no longer need a separate beta/dev MCP to access the beta workflow.

### Modified Capabilities

- planner-runtime: `plan_exit` handoff becomes beta-aware while remaining the same core approval surface.
- build-mode-runtime: workflow runner remains the execution controller but gains beta lifecycle awareness.
- builder-prompt-contract: build-mode instructions stay generic in authority/scope, but can now reference beta-aware mission context and builder-owned routine tooling expectations.

## Impact

- Affects planner approval flow, mission metadata, workflow-runner continuation behavior, and current beta-tool package reuse boundaries.
- Reduces AI token usage and repeated user prompting for routine orchestration while keeping AI focused on coding, debugging, and judgment-heavy tasks.
- Requires updates to architecture docs and event records because builder/runtime responsibilities become beta-aware and beta/dev MCP is no longer the intended end-state surface.
