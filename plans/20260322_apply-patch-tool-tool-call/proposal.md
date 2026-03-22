# Proposal

## Why

- `apply_patch` currently appears opaque while running: the tool card looks static, expand/collapse is effectively unavailable before completion, and long executions feel like a stall across subagent, orchestrator, and TUI layers.
- The user explicitly identified the core problem as not raw duration, but the inability to inspect progress before the tool completes.

## Original Requirement Wording (Baseline)

- "解釋一下apply_patch這個tool的運作流程，因為每次調用這個tool call的時候會出現幾個問題。1. 執行時間非常久 2. 執行過程不透明，subagent停滯、Orchestrator停滯，全都在等apply_patch，卻又掌握不到進度。3. apply_patch標題列的「展開鍵」在完成工作前，按了是沒有回應的，看不到過程。4. 唯一能看到的就是task monitor可以看到有apply_patch卡片存在，但也是靜態卡片，1 不是問題，但是根本問題是3"
- User then selected plan directions `1, 3`: root-cause explanation plus full remediation plan.

## Requirement Revision History

- 2026-03-22: Requirement reframed from generic explanation to a build-ready remediation plan focused on observability and expandability during running state.
- 2026-03-22: User confirmed entering plan mode and requested the work be captured as executable planning artifacts.

## Effective Requirement Description

1. Explain why `apply_patch` cannot be meaningfully expanded before completion.
2. Define a concrete implementation plan that makes the tool card expandable and observable during execution.
3. Keep the solution evidence-first: no fake progress bars, no fallback-derived state, no silent behavior masking.

## Scope

### IN

- The `apply_patch` TUI rendering path in the session route.
- The backend `apply_patch` execution metadata contract.
- Running-state visibility for parse/apply/approval/diagnostics/failure/completion phases.
- Planner artifacts, task breakdown, and event log for implementation handoff.

### OUT

- Generic redesign of all tool renderers.
- Changes to unrelated tool cards (`bash`, `edit`, `task`, etc.) except for compatibility with shared metadata plumbing if strictly required.
- Runtime parallelization or subagent scheduling changes.

## Non-Goals

- Making `apply_patch` intrinsically faster.
- Adding speculative percentages or inferred progress not backed by execution checkpoints.
- Converting the whole TUI to a new progress-card framework.

## Constraints

- Must preserve fail-fast behavior and must not introduce fallback mechanisms.
- Must keep final completed diff/diagnostics UX intact.
- Must respect current approval boundaries instead of bypassing `ctx.ask()`.
- Must align with existing architecture where session UI consumes tool-part state from synced message parts.

## What Changes

- `ApplyPatch` will render as an expandable block during running state instead of falling back to a non-expandable inline placeholder.
- The backend tool will expose explicit phase/progress metadata before final completion.
- Running-state UI will display phase, current file, and completed/total file counts when available.
- Final rendering will continue to display per-file diff and diagnostics once complete.

## Capabilities

### New Capabilities

- Running-state `apply_patch` expandability: operators can open the card before completion.
- Execution-phase visibility: the TUI can show whether the tool is parsing, awaiting approval, applying files, running diagnostics, or failed.
- Progress evidence surface: the UI can show actual file-count progress and current file when emitted by the backend.

### Modified Capabilities

- Existing `apply_patch` card rendering: no longer depends solely on final `metadata.files` to become a block card.
- Backend `apply_patch` metadata: expanded from final `files + diagnostics` only to phased metadata across the execution lifecycle.

## Impact

- Affects TUI operator experience in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`.
- Affects backend tool metadata production in `packages/opencode/src/tool/apply_patch.ts` and potentially shared tool metadata plumbing if incremental updates are not already supported.
- Requires a new event log entry documenting the root cause, design choice, and validation expectations.
