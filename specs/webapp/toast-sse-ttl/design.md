# Design: Toast Scope and TTL over Global SSE

## Context

The Web SPA receives backend events from `/global/event` SSE and reduces them in `GlobalSync`. Toasts are a special ephemeral UI side effect inside that stream. The backend already claims global SSE is live-only, but delayed delivery or reconnect behavior can still surface old toast events if they were queued upstream or emitted with stale timing metadata.

## Goals / Non-Goals

Goals:

- Make toast freshness explicit and required.
- Represent whether a toast is system-wide or user/workspace/session-scoped.
- Drop stale or malformed toast display requests before user-visible rendering.

Non-goals:

- Build durable notification history.
- Redesign all SSE state replay semantics.
- Add fallback routing when scope metadata is missing.

## Current Behavior

- Backend toast events use `tui.toast.show` on the Bus/GlobalBus path and are consumed by the Web SPA through `/global/event` SSE.
- `publishToastTraced` stamps `emittedAt`, but its schema comment still says the frontend must not use it to drop events.
- `GlobalSync` already drops toasts older than 5 seconds, but only when `emittedAt` exists; missing timestamps still display.
- Direct restart toasts in `global.ts` manually emit `tui.toast.show` and must stay aligned with the helper contract.

## Decisions

### DD-1 — Toasts are ephemeral UI signals

Toast events are not state replay. If a client reconnects after a long outage, reducers/resync recover state, while toasts older than their TTL are dropped.

### DD-2 — Scope is explicit

Toast payloads carry `scope`:

- `system`: safe for global/system lifecycle announcements.
- `user`: intended for the authenticated daemon user boundary.
- `workspace`: intended for a workspace/directory context.
- `session`: intended for a concrete session context.

Initial implementation keeps the existing per-user daemon SSE channel but records the intended scope so future multi-user/gateway routing cannot accidentally treat all toasts as global.

### DD-3 — TTL uses publish-time metadata

Toast payloads carry `emittedAt` and `ttlMs`. The frontend computes `Date.now() - emittedAt` and drops the toast when the age is greater than `ttlMs`.

### DD-4 — Missing freshness metadata fails closed on frontend display

Backend publishers should stamp metadata through `publishToastTraced`. If a toast reaches the frontend without `emittedAt` or a valid TTL, the frontend drops it rather than displaying a potentially stale notification.

### DD-5 — No fallback global reroute

User/workspace/session-scoped toasts must not be silently converted to system/global toasts. If a publisher cannot prove a safe scope, it should use the narrowest available context or fail fast during development/test.

## Data Contract

```ts
type ToastScope = "system" | "user" | "workspace" | "session"

type ToastShow = {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration?: number
  emittedAt: number
  ttlMs: number
  scope: ToastScope
}
```

## Implementation Notes

- Default TTL should match the existing default toast duration (`5000ms`) unless a publisher supplies a shorter/longer explicit TTL.
- Long restart notices with `duration: 15000` should use `ttlMs: 15000` so an immediate reconnect can still see them, but a later reconnect cannot.
- Rotation/rate-limit toasts should be `session` or `workspace` scoped when session/directory context exists; otherwise `user` scoped, not `system`.
- Frontend should preserve the existing LLM status-card history capture only for fresh toasts that pass the TTL gate.

## Verification

- Backend schema accepts valid scoped toasts with TTL and rejects malformed scope/TTL.
- Helper stamps `emittedAt`, `ttlMs`, and `scope`.
- Frontend shows fresh toast and drops stale/missing-freshness toasts.
- No direct restart toast lacks TTL/scope.

## Risks / Trade-offs

- Dropping malformed old toasts can hide a non-state notification, but this is safer than showing stale or cross-scope operational details.
- Existing third-party or direct emit sites may fail type/schema checks until updated; this is intentional fail-fast behavior.
- Scope metadata is initially descriptive within the existing per-user daemon channel; it prepares the routing boundary without inventing a new transport.

## Critical Files

- `packages/opencode/src/cli/cmd/tui/event.ts`
- `packages/opencode/src/server/routes/global.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/mcp/index.ts`
- `packages/app/src/context/global-sync.tsx`
