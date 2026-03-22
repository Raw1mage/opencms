# Design

## Context

- The current TUI renderer in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` computes `files = props.metadata.files ?? []` and only renders `BlockTool` when `files().length > 0`.
- The current tool-prop metadata bridge exposes `props.part.state.metadata` for non-pending states, so the UI can consume running-state metadata if the backend emits it.
- The current backend implementation in `packages/opencode/src/tool/apply_patch.ts` computes `files`, applies edits, runs file watchers and LSP diagnostics, then returns `metadata: { diff, files, diagnostics }` only at the end.
- This means execution progress exists in the backend lifecycle, but the TUI has no incremental evidence to render before completion.

## Goals / Non-Goals

**Goals:**

- Make `apply_patch` expandable during running state.
- Introduce a phase-based metadata contract that the TUI can render incrementally.
- Preserve the final completed diff/diagnostics UX.
- Keep the solution local to `apply_patch` and shared metadata plumbing where possible.

**Non-Goals:**

- Redesign every tool card in the TUI.
- Invent fake progress metrics.
- Parallelize patch application.

## Decisions

- Decision 1: `ApplyPatch` should always render on a `BlockTool` surface; the body content changes by phase instead of switching between `InlineTool` and `BlockTool`.
- Decision 2: Backend metadata should adopt explicit phases: `parsing`, `planning`, `awaiting_approval`, `applying`, `diagnostics`, `completed`, `failed`.
- Decision 3: Progress display must be evidence-backed only: total file count, completed file count, and current file may be shown when known; percentages remain optional and should not be synthesized without explicit evidence.
- Decision 4: Final metadata remains backward-compatible by still carrying final `files` and `diagnostics`, so completed diff rendering can reuse the existing renderer logic.

## Data / State / Control Flow

- User/agent emits `apply_patch` with `patchText`.
- Backend parses patch hunks and derives candidate file changes.
- Backend emits early metadata once file-change planning is known.
- If approval is required, the backend emits `awaiting_approval` before `ctx.ask()` blocks.
- Backend applies file changes sequentially and emits `applying` progress as each file begins/completes.
- Backend publishes file/bus updates, runs LSP touch + diagnostics, and emits `diagnostics` before final completion.
- Final completion preserves `files` + `diagnostics` for rich completed-state rendering.

## Risks / Trade-offs

- Runtime metadata plumbing risk -> if the tool framework lacks mid-flight metadata updates, a small shared runtime extension may be required before the local `apply_patch` change is possible.
- UI compatibility risk -> always rendering `BlockTool` may reveal assumptions in collapse/expand behavior that were previously bypassed by `InlineTool`.
- Payload size trade-off -> repeatedly emitting full diff previews for every file could be expensive; planning/applying phases may need a lighter per-file shape than the final completed payload.
- Partial-failure ambiguity risk -> if patch application fails mid-run, the metadata contract must clearly distinguish planned files from successfully applied files.

## Critical Files

- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- `packages/opencode/src/tool/apply_patch.ts`
- `packages/opencode/src/tool/tool.ts`
- `packages/opencode/src/session/message.ts`
- `packages/opencode/src/server/routes/session.ts`
