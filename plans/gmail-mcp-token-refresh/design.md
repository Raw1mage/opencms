# Design: Gmail MCP Background Token Refresh

## Context

- Gmail and Google Calendar share a single OAuth token file at `~/.config/opencode/gauth.json`.
- `packages/opencode/src/mcp/apps/gauth.ts` already refreshes on-demand when a tool request sees a token close to expiry.
- The missing piece is proactive background refresh so token freshness does not depend solely on the next Gmail/Calendar call.

## Goals / Non-Goals

**Goals:**

- Keep Google access tokens fresh before expiry.
- Reuse one shared refresh implementation for Gmail and Calendar.

**Non-Goals:**

- Reworking OAuth consent, callback, or account-binding flow.
- Introducing separate token stores or a fallback auth path.

## Decisions

- Put the background refresh controller next to the shared Google token helper, because the token file and refresh credentials are shared.
- Run the controller once at daemon startup instead of a long-lived polling loop, because lazy loading plus daemon restarts means the Google surface may never be touched during a session.
- Keep on-demand refresh in place, because proactive refresh should reduce failures but not replace fail-fast handling when the background loop misses.
- Have successful refresh update managed-app freshness state, so the UI/status surface reflects actual token health.

## Data / State / Control Flow

- Refresh source: `gauth.json` contains access token, refresh token, expiry, and timestamps.
- Proactive path: daemon-start background controller checks token age/expiry and refreshes ahead of time.
- Reactive path: Gmail tool executor still resolves the access token through the shared helper and refreshes if needed.
- State update path: refresh success should update token persistence and managed-app status/readiness.

## Risks / Trade-offs

- Multiple refresh triggers could race -> serialize refresh work in the shared helper/controller.
- Background work could hide auth configuration problems -> fail fast and log explicit refresh errors.
- Refresh state is derived from `gauth.json`, not a dedicated freshness field -> publish a managed-app update event after refresh so observers re-read state.
- Adding a long-lived daemon loop could feel heavy -> keep it single-purpose and scoped to the shared Google token surface.

## Critical Files

- `packages/opencode/src/mcp/apps/gauth.ts`
- `packages/opencode/src/mcp/index.ts`
- `packages/opencode/src/mcp/app-registry.ts`
- `packages/opencode/src/mcp/apps/gmail/index.ts`

## Supporting Docs (Optional)

- `docs/events/event_20260402_gmail_mcp_refresh.md`
