# Implementation Spec

## Goal

- Add a shared Google MCP background token refresh mechanism that runs on every daemon startup to silently pre-warm Gmail and Calendar tokens before expiry while preserving the existing on-demand refresh safety net.

## Scope

### IN

- Shared background refresh orchestration for `gauth.json`.
- Daemon-start background sweep plus on-demand refresh reuse.
- Managed-app state/reporting updates that expose token freshness and refresh outcomes.

### OUT

- Changing Google OAuth consent or callback flows.
- Introducing a new auth store or per-app token file.
- Adding refresh logic for unrelated MCP providers.

## Assumptions

- Gmail and Google Calendar remain the only managed Google apps that consume `gauth.json`.
- The existing token refresh endpoint and client credentials are sufficient for renewal.
- A daemon-start background sweep is acceptable for the shared Google token surface; it does not require a long-lived polling loop.

## Stop Gates

- Missing Google OAuth client credentials for refresh.
- Evidence that the shared token store is not the correct authority for proactive refresh.
- Any need to change the OAuth flow, token schema, or managed-app state machine beyond the shared refresh layer.
- Stop and re-enter planning if the implementation would require a new fallback mechanism or a separate per-app token source.

## Critical Files

- `packages/opencode/src/mcp/apps/gauth.ts`
- `packages/opencode/src/mcp/apps/gmail/index.ts`
- `packages/opencode/src/mcp/app-registry.ts`
- `packages/opencode/src/mcp/index.ts`
- `packages/opencode/src/server/routes/mcp.ts`
- `docs/events/event_20260402_gmail_mcp_refresh.md`

## Structured Execution Phases

- Baseline and boundary confirmation: verify current on-demand refresh behavior, shared token storage, and the best lifecycle hook for a background refresh controller.
- Shared refresh design: define how the daemon-start sweep schedules proactive refresh, how failures surface, and how managed-app state is updated.
- Implementation and verification: add the background refresh controller, wire it into the daemon/MCP lifecycle, and validate expiry handling with targeted tests.

## Validation

- Targeted tests around `gauth.ts` refresh timing and persistence.
- Managed-app snapshot/status checks to confirm refreshed tokens are reflected in state.
- Typecheck and any related MCP unit tests for the touched files.
- Manual verification that Gmail can remain usable across token expiry windows without user re-auth.

## Handoff

- Build/implementation agent must read this spec first.
- Build/implementation agent must read `tasks.md` and materialize runtime todo from it before coding.
- Conversation memory is supporting context only, not the execution source of truth.
- If scope changes or a new slice appears, update the same plan root unless a new plan is explicitly user-approved.
- At completion time, review implementation against the proposal's effective requirement description.
