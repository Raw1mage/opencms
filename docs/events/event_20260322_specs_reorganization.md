# Event: Specs Folder Reorganization

## Requirement

- User requested a cleanup of `/specs`.
- Move legacy dated packages that are still unimplemented or active-plan in nature into `/plans`.
- Merge implemented legacy dated spec packages with similar subject matter into semantic spec roots under `/specs/<feature>/`.
- User explicitly required implementation-status evidence to come from commits first, not from `tasks.md` alone.

## Scope

### IN

- Triage legacy `specs/<date_slug>/` packages using commit history, event verification, and code blame.
- Move commit-unimplemented packages from `/specs` to `/plans`.
- Consolidate commit-implemented dated packages into conservative semantic roots.
- Update plan/event/architecture docs to reflect the resulting repository information architecture.

### OUT

- Rewriting the substantive technical content of every legacy spec package.
- Re-opening unfinished implementation work just to close old tasks.
- Auto-promoting any `/plans/` package back into `/specs` without semantic evidence.

## Task List

- [x] Re-triage legacy spec roots using commit-level evidence instead of trusting `tasks.md`.
- [x] Ask the user to choose telemetry consolidation posture and semantic naming posture.
- [x] Execute folder moves/merges into `/plans` and semantic `/specs` roots.
- [x] Verify post-migration layout and sync architecture documentation.

## Conversation Summary

- Initial triage over-weighted `tasks.md`; user corrected the standard and required commit-based evidence.
- Re-triage then used `git log --follow`, `git show --stat`, code-path `git blame`, existing event verification, and only secondarily artifact/task content.
- User chose to directly merge telemetry optimization material into the semantic telemetry spec root rather than holding it in `/plans` pending closeout.
- User also chose conservative semantic root names (for example `account-management`, `planner-lifecycle`, `beta-tool`) rather than long historical dated-root names.

## Debug Checkpoints

### Baseline

- `specs/architecture.md` already documents the lifecycle rule: active dated plan/build workspaces belong under `/plans`, while `/specs` is reserved for long-lived semantic roots plus `specs/architecture.md`.
- The repository still contains multiple legacy dated roots under `/specs`, some representing real implemented features and some representing shelved or still-active plans.

### Instrumentation Plan

- Use commit history first to determine whether each legacy package has corresponding implementation evidence.
- Cross-check with event verification/closeout records.
- Use code blame on critical file paths when the commit touches runtime code.
- Treat `tasks.md` as supporting evidence only.

### Execution

- Inline-agent-switch: commit history shows only a shelved spec commit; runtime still uses child-session task flow and `SubagentActivityCard` surfaces.
- Remote-terminal: only pending-spec commit found; no `RemoteToolBackend`, `ToolBackend`, `remoteTarget`, or `opencode remote setup` implementation exists.
- Account-management-refactor: commit `67d337e6eb` implemented the corresponding runtime/account/auth/UI paths; architecture and follow-up event evidence confirm the 3-tier model.
- Telemetry-implementation: commit `6bae3c2b49` implemented bus/projector/reducer telemetry surfaces; dated root is superseded by `specs/telemetry/`.
- Telemetry-optimization: commit `0d5ef22081` implemented context-sidebar card unification/order persistence; user chose to fold this into the telemetry semantic root.
- Plans/specs lifecycle: commit `0e25872e9e` changed planner runtime, prompts, and tests to use `/plans`; this should become a semantic planner-lifecycle spec root.

### Root Cause

- Historic dated planner packages remained under `/specs` even after the lifecycle model changed.
- Repository organization drift happened because implemented dated roots were not normalized into semantic spec roots, and shelved plans were not demoted back into `/plans`.
- `tasks.md` can lag or remain partially open after implementation, so it is not a safe single source for migration decisions.

### Validation

- Commit evidence used:
  - `6eb5ef9cae` for shelved inline-agent-switch specs.
  - `286a9b973d` for pending remote-terminal specs.
  - `67d337e6eb` plus follow-up blame in account/auth/UI paths for account-management implementation.
  - `6bae3c2b49` for telemetry rewrite implementation.
  - `0d5ef22081` for telemetry context-sidebar optimization implementation.
  - `0e25872e9e` for planner lifecycle implementation.
- Event evidence used:
  - `docs/events/event_20260321_telemetry_implementation.md`
  - `docs/events/event_20260322_plans_specs_lifecycle.md`
  - `docs/events/event_20260318_gemini-cli_account_overwrite_fix.md`
- Architecture Sync: Verified (No doc changes) — `specs/architecture.md` already reflected the lifecycle split and semantic-spec rule after the reorganization.

## Key Decisions

- Evidence standard: commit/event/code-blame first; `tasks.md` is advisory only.
- Telemetry consolidation: directly merge dated telemetry optimization provenance into the semantic telemetry root.
- Semantic root naming: use conservative names.
- Planned semantic roots:
  - `specs/account-management/`
  - `specs/planner-lifecycle/`
  - `specs/beta-tool/`
  - existing `specs/telemetry/`
- Planned moves to `/plans`:
  - `plans/20260321_inline-agent-switch/`
  - `plans/20260320_remote-terminal/`
- Executed semantic normalizations:
  - `specs/20260318_account-management-refactor/` -> `specs/account-management/`
  - `specs/20260321_specs/` -> `specs/planner-lifecycle/`
  - `specs/20260320_telemetry-implementation/` -> `specs/telemetry/provenance/20260320_telemetry-implementation/`
  - `specs/20260321_telemetry-optimization/` -> `specs/telemetry/provenance/20260321_telemetry-optimization/`
- Executed second-pass plan demotions:
  - `specs/20260319_account-manager-phase2-hardening/` -> `plans/20260319_account-manager-phase2-hardening/`
  - `specs/20260320_llm/` -> `plans/20260320_llm/`
- Executed second-pass semantic normalizations:
  - `specs/20260321_branch-repo-mcp-cicd/` -> `specs/beta-tool/branch-cicd/`
  - `specs/20260321_beta-tool-branch-beta-branch-beta-repo-specs-20260321-continuous-orchestration-p/` -> `specs/continuous-orchestration/`
  - `specs/20260321_subagent-io-visibility/` -> `specs/subagents/visibility/`
  - `specs/20260318_unified-message-bus/` -> `specs/message-bus/`
  - `specs/20260316_kill-switch/` -> `specs/kill-switch/`

## Second-pass Validation

- Verified destination roots now exist under `/plans` and semantic `/specs` paths for all seven approved second-pass migrations.
- Verified the original dated roots no longer exist under `/specs` for those seven mappings.
- Architecture Sync: Verified (No doc changes) — `specs/architecture.md` already describes the `/plans` vs semantic `/specs` lifecycle and already contains the normalized architecture sections for beta-tool MCP, subagent visibility, and message-bus/kill-switch domains.

## Third-pass Conservative Cleanup

- User rejected further broad speculation and asked for duplicate removal / same-topic consolidation under canonical taxonomy.
- A follow-up taxonomy audit identified clear duplicate clusters: autorunner, planner-lifecycle, and telemetry provenance.
- User approved the conservative cleanup posture: create a canonical `specs/autorunner/`, fold planner dated roots into `specs/planner-lifecycle/`, delete only clearly superseded telemetry provenance packages, keep `plans/shared-context-structure/` unchanged, and leave controversial semantic roots untouched.
- Executed canonicalization:
  - `specs/20260313_autorunner-spec-execution-runner/` + `specs/20260315_autorunner/` -> `specs/autorunner/`
  - `specs/20260315_openspec-like-planner/` + `specs/20260315_easier_plan_mode/` -> `specs/planner-lifecycle/`
- Executed deletions (approved / clear supersession):
  - `specs/telemetry/provenance/20260320_telemetry-implementation/`
  - `specs/telemetry/provenance/20260321_telemetry-optimization/`
- Preserved by explicit instruction:
  - `plans/shared-context-structure/`
  - `plans/20260316_kill-switch-plan/`
  - `specs/account-management/`
  - `specs/continuous-orchestration/`
  - `specs/beta-tool/`
  - `specs/codex/protocol/`

## Third-pass Validation

- Verified `specs/autorunner/` exists with canonical six-pack files plus preserved supporting slices for mission-consumption and delegated-execution baselines.
- Verified `specs/planner-lifecycle/` retained canonical six-pack files and existing JSON modeling artifacts while absorbing dated planner material.
- Verified deleted dated autorunner/planner roots no longer exist under `/specs`:
  - `specs/20260313_autorunner-spec-execution-runner/`
  - `specs/20260315_autorunner/`
  - `specs/20260315_openspec-like-planner/`
  - `specs/20260315_easier_plan_mode/`
- Verified deleted superseded telemetry provenance packages no longer exist under `specs/telemetry/provenance/`.
- Verified preserved untouched roots still exist under their expected paths.
- Architecture Sync: Verified (No doc changes) — `specs/architecture.md` already documents the governing lifecycle rules (`/plans` for active dated roots, `/specs` for semantic roots) and no system/module boundary changed during this cleanup; this pass only normalized repository taxonomy.

## Fourth-pass Canonical Framework Regrouping

- User then requested a stronger semantic regrouping entirely within `/specs` taxonomy.
- Explicit move decisions:
  - `specs/account-management/` -> `plans/account-management/`
  - `specs/codex-protocol/` -> `plans/codex-protocol/`
- Explicit builder framework merge:
  - `specs/beta-tool/`
  - `specs/build_beta/`
  - `specs/planner-lifecycle/`
  - -> `specs/builder_framework/`
- Explicit agent framework merge:
  - `specs/autorunner/`
  - `specs/continuous-orchestration/`
  - `specs/subagents/`
  - `specs/20260315_openclaw_reproduction/`
  - -> `specs/agent_framework/`
- Merge execution preserved source material conservatively under `sources/` subdirectories inside each new canonical root, while adding canonical six-pack summary files at the new root top level.

## Fourth-pass Validation

- Verified moved roots now exist under `/plans`:
  - `plans/account-management/`
  - `plans/codex-protocol/`
- Verified those moved roots no longer exist as top-level `/specs` roots.
- Verified `specs/builder_framework/` exists with canonical summary files and preserved source slices under:
  - `specs/builder_framework/sources/beta-tool/`
  - `specs/builder_framework/sources/build_beta/`
  - `specs/builder_framework/sources/planner-lifecycle/`
- Verified `specs/agent_framework/` exists with canonical summary files and preserved source slices under:
  - `specs/agent_framework/sources/autorunner/`
  - `specs/agent_framework/sources/continuous-orchestration/`
  - `specs/agent_framework/sources/subagents/`
  - `specs/agent_framework/sources/20260315_openclaw_reproduction/`
- Verified merged source roots no longer exist as top-level `/specs/*` roots.
- Architecture Sync: Verified (No doc changes) — `specs/architecture.md` documents lifecycle and system boundaries rather than transient taxonomy names, and this regrouping did not change module boundaries, data flow, or runtime contracts.

## Final-pass Cleanup

- User first asked to consolidate apply-patch duplicates into a semantic `/specs` root, but direct validation found conflicting evidence in `docs/events/event_20260322_apply_patch_observability_plan.md`: the earlier formal promotion had been rolled back and the package explicitly returned to `/plans/20260322_apply-patch-tool-tool-call/` until real mainline implementation lands.
- User then approved the corrected posture: keep apply-patch under `/plans`, consolidate duplicate plan roots only, and do not create `specs/apply-patch-observability/`.
- Duplicate apply-patch roots were consolidated into:
  - `plans/20260322_apply-patch-tool-tool-call/`
- Removed duplicate root:
  - `plans/20260322_plan-tool-i20260322-apply-patch-tool-tool-call/`
- A proposed `prompt_interface` merge was re-audited before execution. Validation showed:
  - `specs/20260317_dialog-optimization/` is actually a TUI message pagination / progressive loading spec, not prompt-interface taxonomy.
  - `specs/system-prompt/` is primarily a source-derived architecture/reference inventory.
  - `specs/kill-switch/` remains a strong independent semantic spec.
  - `specs/telemetry/context-sidebar-optimization/` is the nearest prompt/sidebar UI slice, but it remains subordinate to telemetry boundaries rather than justifying a new root by itself.
- Result: no `specs/prompt_interface/` root was created.
- Final approved audited-root reorganization executed:
  - `specs/20260317_scheduler-persistence-daemon/` -> `plans/20260317_scheduler-persistence-daemon/`
  - `specs/20260318_webapp-provider-gemini-cli-api-key-account-name-account-name-ge/` -> absorbed into `plans/account-management/sources/20260318_webapp-provider-gemini-cli-api-key-account-name-account-name-ge/`
  - `specs/20260319_tui-thin-client-attach/` -> absorbed into `specs/agent_framework/sources/20260319_tui-thin-client-attach/`

## Final-pass Validation

- Verified only one apply-patch plan root remains under `/plans`:
  - `plans/20260322_apply-patch-tool-tool-call/`
- Verified duplicate apply-patch root no longer exists:
  - `plans/20260322_plan-tool-i20260322-apply-patch-tool-tool-call/`
- Verified no erroneous `specs/apply-patch-observability/` root remains.
- Verified the three audited source roots no longer exist at their former `/specs` paths.
- Verified destination roots now contain preserved material:
  - `plans/20260317_scheduler-persistence-daemon/`
  - `plans/account-management/sources/`
  - `specs/agent_framework/sources/20260319_tui-thin-client-attach/`
- Architecture Sync: Verified (No doc changes) — `specs/architecture.md` already captures the repository lifecycle contract (`/plans` for active dated packages, semantic `/specs` for formalized specs) and the final pass only corrected taxonomy/provenance placement without changing module boundaries, data flow, or runtime contracts.

## Remaining

- `plans/shared-context-structure/` still needs an explicit future decision: remain a plans-only exception, merge into an existing semantic root, or be retired.
- `specs/system-prompt/` remains better treated as reference/architecture inventory than as a feature spec; if desired later, it should be normalized by documentation strategy rather than forced into prompt-interface taxonomy.
- New canonical roots may still warrant later content-level flattening if you want fewer preserved `sources/` subtrees:
  - `specs/builder_framework/`
  - `specs/agent_framework/`
