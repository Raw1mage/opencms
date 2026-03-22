# Implementation Spec

## Goal

- Rework the telemetry branch context sidebar so the legacy loose-text context information is reorganized into three draggable cards (`Summary`, `Breakdown`, `Prompt`) that visually align with the newer telemetry card layout.

## Scope

### IN

- `packages/app` context sidebar / context tab presentation on the `telemetry` branch
- Re-grouping the legacy context information into three cards for layout consistency with telemetry cards
- Adding drag-and-drop ordering for context sidebar cards, following the task status sidebar interaction model
- Any small supporting refactor needed to make context-card ordering and rendering maintainable
- Adding targeted tests for context sidebar card rendering or ordering behavior

### OUT

- Re-architecting backend telemetry capture ownership or `session.top` transport contract
- Changing TUI sidebar behavior
- Adding new fallback mechanisms or silent cross-surface authority rescue paths
- Broad redesign of unrelated file tree / todo / monitor launcher UX
- Reworking status sidebar cards outside of any shared ordering utility explicitly needed by context sidebar

## Assumptions

- The user wants to preserve the existing context information content, but regroup it into 3 cards rather than a loose text list.
- The main target is layout consistency between old context information and the newer telemetry cards.
- Drag ordering should behave like the task status sidebar and persist through the existing app layout model unless implementation reveals a bounded limitation that requires re-planning.
- Telemetry truth ownership remains governed by `specs/telemetry/`, not by this UI slice.

## Stop Gates

- Stop if implementing draggable context cards would require changing a broader global sidebar persistence contract beyond a bounded shared utility extraction.
- Re-enter planning if the requested card grouping cannot be achieved without changing backend telemetry/context data contracts.
- Stop if a proposed implementation would require introducing a new fallback path instead of using existing context/telemetry state.

## Critical Files

- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/tool-page.tsx`
- `packages/app/src/components/session/session-context-tab.tsx`
- `packages/app/src/pages/session/session-telemetry-cards.tsx`
- `packages/app/src/context/layout.tsx`
- `packages/app/src/pages/session/session-status-sections.tsx`
- `packages/app/e2e/prompt/context.spec.ts`

## Structured Execution Phases

- Phase 1: define the context sidebar card groups and ordering contract (`Summary`, `Breakdown`, `Prompt`).
- Phase 2: refactor `SessionContextTab` to render legacy context information as three cards alongside telemetry cards.
- Phase 3: add draggable ordering and persisted order state for context sidebar cards, reusing status-sidebar patterns where safe.
- Phase 4: validate rendering/order behavior and typecheck the app.
- Phase 5: sync event documentation with the final UI/data-boundary outcome.

## Validation

- `bun --filter @opencode-ai/app typecheck`
- Targeted tests for any extracted card-ordering/render logic and touched context sidebar helpers/components
- If the context sidebar interaction changes materially, run the relevant context/sidebar e2e or targeted UI verification slice
- Manual verification that context sidebar now presents legacy context info as grouped cards and supports drag reordering

## Handoff

- Build agent must read this spec first.
- Build agent must read `proposal.md`, `spec.md`, `design.md`, `tasks.md`, and the active event log before coding.
- Build agent must materialize runtime todo from `tasks.md` before coding.
- Conversation memory is supporting context only, not the execution source of truth.
- If scope changes or a new slice appears, update the same telemetry root unless a new split is explicitly user-approved.
- At completion time, review implementation against the proposal's effective requirement description.
