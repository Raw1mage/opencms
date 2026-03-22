# Implementation Spec

## Goal

- Optimize the existing hardcoded builder control plane so entering build mode automatically follows the beta development workflow on a new branch/worktree based on the mainline, handles routine branch/checkout/commit/push/pull/syncback operations through deterministic built-in tooling, and returns a testable branch to the main repo before pausing for merge approval, with the long-term end state being that builder owns this capability natively and the external beta/dev MCP surface is deprecated and removed.

## Scope

### IN

- Extend the existing builder flow rather than replacing it: keep current `plan_exit`, mission, workflow-runner, and runner contract responsibilities intact where possible.
- Teach builder to understand beta-loop lifecycle stages: beta bootstrap, beta worktree execution, commit/push/pull coordination, syncback-based validation, branch-drift remediation, and approval-gated merge finalize.
- Reuse and then absorb shared beta orchestration logic so routine git/worktree/runtime operations become deterministic builder-owned capabilities and do not require repeated AI reasoning or repeated user prompting.
- Add builder handoff metadata and runtime state needed to carry beta workflow context safely through build mode.
- Include remote push/pull in the builder-controlled lifecycle while preserving explicit approval gates where required by policy.
- Define beta/dev MCP as a migration surface only, not the target steady-state control plane.
- Preserve explicit stop gates for ambiguity, dirty trees, validation failures, destructive finalize approval, planner-root overwrite risk, branch cleanliness invariants around bootstrap/syncback, and branch-drift / rebase approval boundaries.
- Add a `plan_enter` anti-clobber guard so existing non-template plan content is never blindly replaced by templates.
- Constrain planner/spec/event document writes to the authoritative main repo/worktree only; planning may be triggered while working from beta, but document storage must never fork into beta worktrees.
- Update active planning artifacts and long-lived docs affected by the workflow change.

### OUT

- Rewriting builder into a brand-new control system or replacing existing build-mode runtime.
- Removing or silently changing existing builder capabilities unrelated to beta workflow integration.
- Automatic unapproved merge/cleanup during normal build-mode progression.
- Silent fallback when repo root, base branch, runtime policy, branch name, or merge target is ambiguous.
- Keeping beta/dev MCP as the long-term primary workflow surface once builder has absorbed the capability.
- Browser automation or test-specific policy beyond invoking configured runtime commands.

## Assumptions

- Existing builder behavior has value and must remain backward-compatible unless a specific flow improvement is explicitly required.
- `plan_exit` remains the authoritative approval gate before build-mode starts.
- Routine local and remote git operations should be builder-owned defaults so the user does not need to keep restating them in prompts.
- Builder is the desired long-term owner of beta workflow; MCP is only a temporary implementation/migration aid.
- Runtime validation in this repo still maps to `./webctl.sh dev-start` / `dev-refresh`, but the absorbed beta flow must remain project-aware and generic.

## Stop Gates

- Stop if the approved plan does not explicitly declare beta-loop execution intent, validation posture, and finalize posture.
- Stop if beta bootstrap cannot resolve repo root, base branch, branch name, beta root, or runtime policy without an explicit bounded decision.
- Stop if either main worktree or target beta path is dirty, conflicting, or already mapped incompatibly.
- Stop before beta bootstrap unless mainline worktree state is anchored to a clean committed head.
- Stop before syncback unless the beta branch has a clean committed head representing the changes to validate.
- Stop if the proposed builder integration would remove, bypass, or regress existing builder capabilities instead of only layering beta workflow guidance on top.
- Stop if build execution discovers a new workflow slice not represented in planner artifacts.
- Stop before destructive finalize actions (`merge`, worktree removal, branch deletion); builder may prepare merge preflight but actual finalize still requires explicit approval.
- Stop when base/main branch has advanced relative to beta and builder reaches a rebase/remediation point; detect drift automatically, prepare remediation metadata, and require explicit approval before rebase onto the new mainline.
- Stop before remote operations that project policy classifies as explicit approval-required, but otherwise allow builder-owned push/pull as part of routine execution.
- Stop if `plan_enter` detects an existing planner root with partial or real non-template content that would be overwritten; require reuse or explicit recovery path instead of template rewrite.
- Stop if planner/spec/event writes would be resolved into a beta worktree instead of the authoritative main repo/worktree; planning state must stay anchored to main even when execution is happening from beta.

## Critical Files

- packages/opencode/src/tool/plan.ts
- packages/opencode/src/session/planner-layout.ts
- packages/opencode/src/session/beta-bootstrap.ts
- packages/opencode/src/session/index.ts
- packages/opencode/src/session/workflow-runner.ts
- packages/opencode/src/session/prompt/runner.txt
- packages/opencode/src/session/prompt.ts
- packages/mcp/branch-cicd/src/beta-tool.ts
- packages/mcp/branch-cicd/src/context.ts
- packages/mcp/branch-cicd/src/project-policy.ts
- specs/architecture.md
- docs/events/event_20260321_beta_tool_plan_exit_build_loop.md

## Structured Execution Phases

- Map the existing builder control plane and preserve its current responsibilities while identifying the narrowest safe beta-flow insertion points.
- Extract and internalize deterministic beta orchestration primitives so routine git/worktree/commit/push/pull/runtime steps move out of ad hoc AI reasoning and into builder-owned execution.
- Enforce clean-head branch invariants so bootstrap and syncback both operate only on committed, non-dirty branch heads.
- Add `plan_enter` planner-root integrity checks so existing plan artifacts are reused or explicitly blocked instead of silently reinitialized.
- Add planner-location guards so plan/spec/event document authoring is always routed to storage in the main repo/worktree, never a beta worktree, regardless of the current execution surface.
- Extend `plan_exit` and mission handoff so builder can enter beta bootstrap without replacing existing build entry behavior.
- Extend build execution so validation uses syncback semantics, branch drift is detected and prepared for remediation, and finalize uses merge preflight plus approval-gated merge, while keeping existing builder stop-gate semantics intact.
- Add migration and deprecation steps so external beta/dev MCP surface is no longer required once builder-native flow is stable.
- Validate that legacy builder behavior still works for non-beta flows and that beta-aware flows reduce routine AI tool chatter and user prompt repetition.
- Sync documentation and architecture records to reflect the optimized builder workflow.

## Validation

- Run targeted unit tests for `plan_enter`, `plan_exit`, mission metadata, workflow-runner continuation, and any new beta-aware builder state.
- Run targeted tests for the absorbed/shared beta orchestration core to prove builder-native behavior matches intended branch/worktree semantics.
- Verify existing non-beta build-mode behavior still passes unchanged or with compatible metadata additions.
- Verify a representative approved beta-aware plan can produce: beta bootstrap metadata, build-mode handoff, commit/push/pull-aware routine execution, syncback-driven validation, and merge-preflight metadata while still pausing for explicit merge approval.
- Verify bootstrap is rejected when mainline is dirty and syncback is rejected when beta changes are not committed.
- Verify deterministic builder-owned tooling replaces routine AI-driven git/worktree orchestration rather than adding prompt-only steps.
- Verify common branch-drift scenarios produce rebase/remediation preflight with explicit approval instead of silent history rewrite.
- Verify external beta/dev MCP is no longer required for the target end-to-end builder UX.
- Record architecture sync and event evidence for the updated builder boundary.

## Handoff

- Build agent must read this spec first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md / handoff.md before coding.
- Build agent must materialize runtime todo from tasks.md and preserve planner task naming.
- Build agent must optimize the existing builder, not replace it with a new orchestration model unless the current flow makes preservation impossible and that change is re-approved.
- Build agent must implement beta bootstrap, routine git orchestration, syncback validation, and merge preflight as builder-native deterministic behavior rather than repeated AI reasoning.
- Build agent must treat beta/dev MCP as temporary migration scaffolding, not the final user-facing workflow dependency.
- Build agent must preserve fail-fast behavior and explicit question/approval gates instead of adding fallback branches.
