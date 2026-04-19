# Design — web connection stale status fix

## Context

- The web frontend currently derives part of its process-card elapsed display from monitor projection freshness rather than true worker runtime.
- Under weak network conditions, stale event-driven UI can outlive the authoritative backend state and mislead operators.

## Goals / Non-Goals

### Goals

- Make degraded transport visible as a first-class UI state.
- Ensure active-child and elapsed surfaces are revalidated from server authority after recovery.
- Prevent unsafe input while authority is uncertain.

### Non-Goals

- Redesign the backend SSE protocol.
- Rebuild subagent worker lifecycle.
- Introduce silent fallback execution semantics.

## Decisions

- Model connection quality as an explicit state machine rather than implicit retry behavior.
- Treat active-child/footer/counter surfaces as provisional while degraded.
- Use snapshot-style revalidation after reconnect/reload/resume before restoring interactive controls.

## Risks / Trade-offs

- More explicit degraded UI may feel stricter, but it avoids false confidence.
- Blocking input during degraded state may frustrate users briefly, but preserves authority correctness.
- Some existing monitor surfaces may need semantic changes if they currently assume elapsed == running time.

## Critical Files

- `packages/app/src/context/global-sdk.tsx`
- `packages/app/src/context/global-sync/event-reducer.ts`
- `packages/app/src/pages/session/monitor-helper.ts`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/components/prompt-input.tsx`
- `packages/opencode/src/session/monitor.ts`
