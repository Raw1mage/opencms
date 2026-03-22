# Proposal

## Why

- The current context sidebar visually splits into an older loose text-list area and a newer telemetry card area, making the layout feel inconsistent.
- The user wants the older context information regrouped into 3 cards so the entire context sidebar feels like one coherent card-based surface.
- The user also wants those cards to support drag reordering, matching the task status sidebar interaction style.

## Original Requirement Wording (Baseline)

- "Telemetry Optimization。在/home/pkcs12/projects/opencode的branch telemetry工作，對context sidebar的顯示畫面進行優化。"

## Requirement Revision History

- 2026-03-21 planning: scoped the request to the `telemetry` branch context sidebar / related app surfaces in `packages/app`, based on architecture + event review + source exploration.
- 2026-03-21 user clarification: the optimization target is specifically the mixed old/new context sidebar layout; legacy context info should be regrouped into 2-3 cards and made draggable like the task status sidebar.
- 2026-03-21 planning refinement: user selected the initial 3-card grouping as `摘要 / Breakdown / Prompt`.

## Effective Requirement Description

1. Convert the older loose-text context sidebar information into 3 grouped cards (`摘要 / Breakdown / Prompt`) so the context sidebar layout is visually consistent with the telemetry cards.
2. Add drag-and-drop card ordering to the context sidebar, aligned with the task status sidebar behavior.
3. Keep the work inside current web app context/sidebar surfaces unless implementation reveals a bounded shared utility change is needed.
4. Keep this slice subordinate to the bus-first telemetry rewrite contract documented in `specs/telemetry/`.

## Scope

### IN

- Context sidebar / context tab display behavior in `packages/app`
- Card grouping of existing legacy context information
- Context sidebar drag ordering and any needed persisted ordering state
- Targeted display-layer tests and documentation sync

### OUT

- Backend telemetry event capture redesign
- TUI sidebar changes
- Unrelated session launcher or file-tree redesign

## Non-Goals

- Replacing the app telemetry store with a new state model
- Solving every telemetry authority limitation across the repo in this slice
- Adding extra fallback logic to hide missing authoritative data
- Redesigning the full status sidebar beyond reusable ordering primitives

## Constraints

- Must respect the current architecture boundary: UI surfaces consume app-side `session_telemetry`; they do not become telemetry truth owners.
- Must not silently add new fallback mechanisms.
- Must keep plan/task naming aligned with visible runtime todo once the work enters build mode.

## What Changes

- `SessionContextTab` will be reorganized from a loose stacked text layout into a small set of cards.
- The context sidebar will gain drag-and-drop card ordering, likely borrowing patterns from the task status sidebar.
- Supporting layout/persistence utilities may be extended if needed to remember context card order.

## Capabilities

### New Capabilities

- Context card ordering: users can rearrange context sidebar cards.

### Modified Capabilities

- Context sidebar display: legacy information will be presented as grouped cards instead of loose text rows.
- Context sidebar layout: card order becomes user-adjustable.

## Impact

- `packages/app` session sidebar/context UI
- Potentially `packages/app/src/context/layout.tsx` or adjacent persisted layout state if context card ordering is remembered globally
- Targeted app tests
- `docs/events` sync within the consolidated telemetry root
