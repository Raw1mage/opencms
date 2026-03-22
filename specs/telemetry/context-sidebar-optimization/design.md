# Design

## Context

- Current architecture says runtime emits telemetry facts, server/app build projections, and UI surfaces are pure consumers.
- In the current context sidebar, the new telemetry area already uses cards, while the older context information is still presented as a looser stacked text layout.
- `session-context-tab.tsx` is the primary file that will need visual regrouping; drag ordering may also require shared layout-state work similar to the task status sidebar.

## Goals / Non-Goals

**Goals:**

- Normalize the context sidebar into a unified card layout.
- Preserve the existing information while regrouping it into three cards: `Summary`, `Breakdown`, and `Prompt`.
- Add draggable ordering in a way consistent with the status sidebar interaction.

**Non-Goals:**

- Rebuild server-side telemetry projection ownership.
- Add new hidden fallback behavior to mask missing telemetry authority.
- Turn context sidebar optimization into a whole-session layout redesign.

## Decisions

- User direction captured: the primary objective is cardizing the old context info and making those cards reorderable.
- Initial grouping is fixed as three cards: `Summary`, `Breakdown`, and `Prompt`.
- The plan keeps existing data boundaries and treats this as a display/layout refactor, not a telemetry authority rewrite.
- Reordering should follow the task status sidebar model as closely as practical, but only extend shared persistence/state boundaries when explicitly necessary.

## Data / State / Control Flow

- `SessionContextTab` combines context metrics (`getSessionContextMetrics`, `estimateSessionContextBreakdown`), system prompt content, and optional `SessionTelemetry` props.
- The likely refactor boundary is inside the context-tab composition layer: split the current long stacked content into several card sections with stable identifiers.
- Drag ordering will require a card order source, likely persisted through existing layout-state patterns if that can be done without over-broad coupling.
- All telemetry data consumed here remains downstream of the canonical reducer-owned telemetry slice defined in `specs/telemetry/`.

## Risks / Trade-offs

- Card grouping improves consistency, but poor grouping could make the sidebar feel arbitrary -> mitigate by using the user-approved `Summary / Breakdown / Prompt` buckets.
- Reusing status-sidebar drag infrastructure reduces UX drift, but may require touching shared layout persistence -> mitigate by keeping the shared change bounded to context-card ordering only.
- Making every subsection draggable could over-fragment the UI -> mitigate by grouping legacy info into only three cards, per user request.

## Critical Files

- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/tool-page.tsx`
- `packages/app/src/components/session/session-context-tab.tsx`
- `packages/app/src/pages/session/session-telemetry-cards.tsx`
- `packages/app/src/context/layout.tsx`
- `packages/app/src/pages/session/session-status-sections.tsx`

## Supporting Docs (Optional)

- `docs/events/event_20260321_session_telemetry_context_hydration.md`
- `docs/events/event_20260321_telemetry_implementation.md`
- `docs/events/event_20260315_sidebar_status_card_simplify.md`
