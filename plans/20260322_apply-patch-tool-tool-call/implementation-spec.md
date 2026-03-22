# Implementation Spec

## Goal

- Make `apply_patch` observable and expandable while running in the TUI by removing the completed-only render gate and introducing execution-phase metadata updates.

## Scope

### IN

- Redesign the TUI `ApplyPatch` renderer so the card uses an expandable block surface during running state, not only after `metadata.files` exists.
- Add an explicit `apply_patch` metadata shape that can represent execution phases, progress, current file, and final diagnostics.
- Update the `apply_patch` backend execution path to emit incremental metadata at stable checkpoints before final completion.
- Preserve final diff and diagnostics rendering after completion.
- Validate the new UX against multi-file patch, approval wait, diagnostics wait, and failure states.

### OUT

- Rewriting the generic tool-part rendering system for all tools.
- Replacing the permission / approval contract used by `ctx.ask()`.
- Inventing fake percentage progress or fallback-derived progress signals without execution evidence.
- Broad TUI redesign outside the `apply_patch` card and adjacent metadata plumbing.

## Assumptions

- The runtime tool execution layer can support mid-flight metadata updates for a running tool part, or can be minimally extended to do so without reworking unrelated tool infrastructure.
- Existing final `metadata.files` and `metadata.diagnostics` consumers can be preserved while adding richer phase/progress fields.
- `apply_patch` remains a sequential tool execution path; this work improves observability, not concurrency semantics.

## Stop Gates

- Stop and re-enter planning if the tool runtime cannot publish incremental metadata for running parts without a larger event-model refactor.
- Stop if the TUI `BlockTool` contract requires a cross-tool architectural change rather than a local `ApplyPatch` renderer change.
- Stop if approval/permission rendering semantics turn out to be coupled to `InlineTool` assumptions elsewhere in the session route.
- Stop before introducing any fallback or guessed progress signal not directly backed by execution evidence.

## Critical Files

- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- `packages/opencode/src/tool/apply_patch.ts`
- `packages/opencode/src/tool/tool.ts`
- `packages/opencode/src/session/message.ts`
- `packages/opencode/src/server/routes/session.ts`
- `docs/events/event_20260322_apply_patch_observability_plan.md`

## Structured Execution Phases

- Phase 1: Trace the current `apply_patch` tool-part lifecycle and introduce a stable metadata contract for running/complete/error states.
- Phase 2: Rewrite the TUI `ApplyPatch` renderer so running-state cards are expandable and can display phase/progress placeholders before file diff metadata is complete.
- Phase 3: Extend backend `apply_patch` execution to emit checkpoint metadata (`parsing`, `planning`, `awaiting_approval`, `applying`, `diagnostics`, `completed`, `failed`) and preserve final diff/diagnostics output.
- Phase 4: Validate multi-file, approval, diagnostics, and failure behavior; then sync event documentation and confirm architecture impact.

## Validation

- Read-path validation: confirm the TUI no longer gates `ApplyPatch` on `metadata.files.length > 0` alone.
- Runtime validation: execute an `apply_patch` call touching multiple files and verify the card can be expanded before completion.
- UX validation: observe distinct running labels for at least `parsing`, `applying`, and `diagnostics` phases.
- Failure validation: verify failed patch application surfaces a `failed` phase and any available partial file state.
- Regression validation: confirm final completed rendering still shows file diffs and diagnostics for changed files.
- Documentation validation: update the event log and record `Architecture Sync: Verified (No doc changes)` if module boundaries remain unchanged.

## Handoff

- Build agent must read this spec first.
- Build agent must read `proposal.md`, `spec.md`, `design.md`, `tasks.md`, and `handoff.md` before coding.
- Build agent must materialize runtime todo from `tasks.md` and preserve planner task naming.
- Build agent must prefer delegation-first execution for bounded verification slices, but documentation updates remain orchestrator-owned.
