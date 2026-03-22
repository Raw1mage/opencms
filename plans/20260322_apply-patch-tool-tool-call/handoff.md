# Handoff

## Execution Contract

- Build agent must read `implementation-spec.md` first.
- Build agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Materialize `tasks.md` into runtime todos before coding.
- Preserve planner task naming in user-visible progress.
- Prefer delegation-first execution for bounded verification or tracing slices, but orchestrator retains ownership of event/architecture documentation.

## Required Reads

- `implementation-spec.md`
- `proposal.md`
- `spec.md`
- `design.md`
- `tasks.md`

## Current State

- Planning evidence confirms the root cause: `ApplyPatch` only becomes a `BlockTool` after final `metadata.files` exists.
- Backend evidence confirms current `apply_patch` returns `files` and `diagnostics` only at the end, after file writes, file-watch notifications, and LSP diagnostics.
- No code has been changed yet in this plan package.

## Stop Gates In Force

- Stop if running-state metadata updates require a broad runtime event refactor.
- Stop if `BlockTool` cannot safely represent pending/running states without changing shared TUI behavior outside this feature.
- Stop before adding any progress signal that is not backed by execution evidence.

## Build Entry Recommendation

- Start with Task Group 1: confirm the incremental metadata API available to tools and define the exact `ApplyPatchMetadata` shape before touching the renderer.

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in `tasks.md`
