# Proposal: webapp_toast-sse-ttl

## Why

- A long-idle client can reconnect to the global SSE stream and surface stale `tui.toast.show` notifications long after the underlying event is no longer actionable.
- Toast delivery currently mixes system-wide announcements and user/workspace/session-scoped events on one global event channel, which risks showing user-specific operational details to the wrong browser/user boundary if future multi-user routing expands.
- The existing frontend TTL guard only works when `emittedAt` is present, while the backend schema still documents `emittedAt` as trace-only and says the frontend must not drop old toasts.

## Original Requirement Wording (Baseline)

- "如果有一個client掛機很久了。他重新連接sse時，會連續收到過去幾小時以來累積的各種toaster。我覺得toaster通知要區分層級。系統層級的是global發送，而user層級的事件不可混發給不同user，會有資安問題。另外，toaster的事件應該要有TTL。前端不應該讓幾小時的事件在幾小時後還在顯示toaster"
- Follow-up: "先寫一個plan再實作。實作完成後再把plan併到主specs中對應功能分類下"

## Requirement Revision History

- 2026-05-22: initial draft created via plan-init.ts

## Effective Requirement Description

1. Define toast events as scoped notifications, not generic global broadcasts.
2. Preserve global/system toasts for system-wide lifecycle events, but make user/workspace/session-sensitive toasts carry explicit audience scope metadata.
3. Add a TTL contract to toast events so the frontend drops stale notifications on reconnect or delayed delivery.
4. Keep state recovery via existing reducer/resync paths; do not use toasts as durable state replay.
5. After implementation and validation, graduate the finished plan into the `specs/webapp/` knowledge base area as the canonical feature spec.

## Scope

### IN
- Backend toast event schema and publish helper contract.
- Global SSE forwarding behavior for toast envelopes.
- Frontend `GlobalSync` toast consumption and TTL drop behavior.
- Tests for fresh, stale, missing timestamp, and scope-safe toast handling.
- Plan artifacts and post-implementation spec consolidation under `specs/webapp/`.

### OUT
- Full SSE event replay redesign.
- Durable notification inbox/history.
- Browser push notifications.
- Cross-host gateway federation policy.

## Non-Goals

- Do not add a fallback mechanism that silently reroutes user-scoped toasts to global delivery.
- Do not make frontend connectivity health visible as a toast.
- Do not rely on client-side filtering as the only security boundary for cross-user data.

## Constraints

- Fail fast when a user-scoped toast lacks enough context for safe delivery.
- Preserve existing Bus infrastructure; do not introduce polling or ad-hoc async coordination.
- Keep global SSE live-only for state events; TTL applies to ephemeral toast display, not durable state reducers.
- Avoid leaking provider/account/session details across user boundaries.

## What Changes

- `TuiEvent.ToastShow` gains explicit freshness/audience semantics.
- `publishToastTraced` stamps freshness metadata and requires explicit scope classification.
- Direct backend `GlobalBus.emit` toast sites are aligned with the same metadata contract.
- `GlobalSync` drops stale or malformed ephemeral toasts before calling `showToast`.

## Capabilities

### New Capabilities
- Toast TTL: stale toast events are ignored after their display window expires.
- Toast audience scope: system/global versus user/workspace/session intent is represented in the event payload.

### Modified Capabilities
- Global SSE toast forwarding: remains live event delivery, but toast display is freshness-gated.
- Frontend toast consumption: no longer shows hours-old backend toasts after reconnect/delayed delivery.

## Impact

- Backend: `packages/opencode/src/cli/cmd/tui/event.ts`, direct restart toast sites in `packages/opencode/src/server/routes/global.ts`, and toast publishers under session/MCP paths.
- Frontend: `packages/app/src/context/global-sync.tsx` toast handler.
- Tests/docs: adjacent frontend/backend unit tests plus `specs/webapp/` consolidation after verification.
