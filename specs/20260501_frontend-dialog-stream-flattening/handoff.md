# Handoff

## Execution Contract

Implement frontend display flattening only. Do not change backend session/runloop behavior.

## Required Reads

- `plans/20260501_frontend-dialog-stream-flattening/proposal.md`
- `plans/20260501_frontend-dialog-stream-flattening/design.md`
- `packages/app/src/pages/task-list/task-detail.tsx`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/ui/src/components/session-turn.tsx`

## Stop Gates

- Stop before daemon/gateway restart or reload.
- Stop if flattening requires changing message reducer IDs or backend event contract.
- Stop if accessibility primitives need removal.

## Acceptance

- Dialog/task stream is describable as one canvas plus card types.
- Live state uses turn status line only.
- No new frontend runloop grouping state is added.
- Focused typecheck/build passes.
