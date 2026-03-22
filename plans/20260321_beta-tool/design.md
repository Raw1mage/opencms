# Design

## Context

- `packages/opencode/src/tool/plan.ts` already acts as the hardcoded build-entry gate by validating artifacts, materializing todos, persisting mission metadata, and injecting a synthetic build-mode handoff.
- `packages/opencode/src/session/index.ts` and `packages/opencode/src/session/workflow-runner.ts` already form the runtime control plane for build-mode continuation, pause conditions, and mission consumption.
- `packages/opencode/src/session/prompt/runner.txt` provides the generic build-mode execution contract, but it does not currently encode beta lifecycle guidance.
- `packages/mcp/branch-cicd` already implements the concrete beta workflow logic, but this should become migration scaffolding rather than the long-term user-facing surface.
- `packages/opencode/src/tool/plan.ts` currently initializes planner artifacts by checking only whether `implementation-spec.md` exists; this is too weak to protect partially populated or previously curated planner roots from accidental template rewrite.
- User requirement is explicitly conservative: optimize the existing builder flow, do not break current capabilities, reduce AI dependence for routine git/worktree/runtime operations, and eventually eliminate the need for beta/dev MCP in normal usage.

## Goals / Non-Goals

**Goals:**

- Preserve the existing builder control plane and optimize it rather than replacing it.
- Internalize beta bootstrap, routine git flow, syncback validation, and merge preflight as builder-native deterministic behavior.
- Make beta bootstrap, syncback validation, and merge preflight first-class builder lifecycle stages.
- Reduce routine AI token spend by moving deterministic orchestration into builder-owned tooling.
- Preserve explicit question/approval gates and fail-fast behavior.

**Non-Goals:**

- Replace builder with a new standalone control system.
- Auto-run merge or cleanup when build succeeds without explicit approval.
- Hide project/runtime ambiguity behind fallback defaults.
- Keep beta/dev MCP as the steady-state primary workflow surface.

## Decisions

- Add planner-root integrity checks to `plan_enter` so artifact initialization only happens for truly empty/template roots and fails fast for ambiguous partial roots.
- Keep `plan_exit`, mission, workflow-runner, and runner contract as the backbone of builder execution; extend them narrowly for beta awareness instead of replacing them.
- Internalize the project-aware branch/worktree/runtime logic currently modeled in `packages/mcp/branch-cicd` as builder-owned deterministic behavior.
- Extend planner artifacts and handoff metadata so beta-loop execution is explicit, not inferred from the mere existence of beta-tool.
- Build-mode validation should use syncback-equivalent operations plus runtime policy execution; manual runtime policy remains a stop/report path instead of an implicit command fallback.
- Branch transitions must use clean committed heads as boundaries: dirty mainline cannot seed beta bootstrap, and dirty beta work cannot seed syncback validation.
- Successful build progression should enter builder-owned merge preflight, but destructive finalize actions still require an explicit approval stop gate.
- Protect existing builder behavior by treating non-beta plans as a compatibility path that should continue to work without beta-specific churn.
- Treat beta/dev MCP as migration scaffolding only, then deprecate/remove it once builder-native flow is stable.

## Data / State / Control Flow

- Planner-root integrity checks run at `plan_enter` time before template materialization.
- Planner artifacts define whether beta-loop execution is in scope and what validation/finalize posture is required.
- Bootstrap checks mainline cleanliness before creating/reusing beta branch state.
- Syncback checks beta branch cleanliness and committed-head presence before validation can proceed.
- `plan_exit` validates artifacts, materializes tasks, resolves beta execution metadata, and runs builder-native beta bootstrap before persisting mission handoff when beta flow is enabled.
- Mission/handoff metadata carries beta context (repo root, main worktree, beta path, branch name, base branch, runtime policy, validation posture, finalize posture) into build mode.
- Workflow runner remains the continuation controller; when it reaches a beta-aware validation slice, builder uses built-in syncback-equivalent orchestration to update the main worktree and optionally run runtime commands.
- Successful validation returns control to normal build progression; builder then enters merge preflight and pauses for explicit approval before finalize operations.
- Non-beta plans bypass beta-specific stages and continue through the legacy-compatible builder path.

## Risks / Trade-offs

- Planner-root integrity checks can block some previously tolerated partial states -> mitigate by distinguishing empty/template roots from real-content roots and by adding focused tests.
- Internalizing beta primitives touches both builder runtime and current MCP package boundaries -> mitigate by keeping behavior signatures close to current semantics and adding focused tests.
- Adding beta awareness to builder can accidentally regress legacy build flow -> mitigate with explicit compatibility checks and by making beta metadata opt-in.
- Dirty-tree stop gates may feel stricter than ad hoc manual workflows -> mitigate by making clean-head invariants explicit in builder behavior and validation docs.
- Deterministic tooling reduces token use but adds runtime coupling -> mitigate by keeping the built-in primitive layer narrow and observable.
- Finalize-loop automation can blur operator expectations -> mitigate by documenting clear stop gates and explicit merge approval.

## Critical Files

- /home/pkcs12/projects/opencode/packages/opencode/src/tool/plan.ts
- /home/pkcs12/projects/opencode/packages/opencode/src/session/index.ts
- /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.ts
- /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt/runner.txt
- /home/pkcs12/projects/opencode/packages/mcp/branch-cicd/src/beta-tool.ts
- /home/pkcs12/projects/opencode/packages/mcp/branch-cicd/src/context.ts
- /home/pkcs12/projects/opencode/packages/mcp/branch-cicd/src/project-policy.ts
