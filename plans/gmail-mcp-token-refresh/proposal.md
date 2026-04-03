# Proposal: Gmail MCP Background Token Refresh

## Why

- Gmail managed app tokens can expire between tool calls, causing avoidable auth failures during active use.
- The current behavior only refreshes on-demand when a Gmail tool is invoked, so expired tokens can still surface as runtime friction.
- Lazy-loading means daemon restarts can leave Google-managed MCP apps untouched unless startup performs a proactive sweep.

## Original Requirement Wording (Baseline)

- "mcp gmail的auth經常過期。這個需要一個自動refresh token的機制在背景處理"

## Requirement Revision History

- 2026-04-02: Scope refined from Gmail-only fix to shared Google MCP token handling, because Gmail and Google Calendar already share `gauth.json` and the same refresh primitive.
- 2026-04-02: Chosen behavior is proactive background refresh plus on-demand refresh, so the system both pre-warms tokens and still fails fast on unexpected auth drift.
- 2026-04-02: Lifecycle refined again to daemon-start background sweep, because lazy loading plus frequent daemon restarts means the MCP surface may not be touched during a session.

## Effective Requirement Description

1. A shared Google MCP background sweep SHALL proactively refresh Gmail/Calendar access tokens before expiry.
2. The existing on-demand refresh path SHALL remain in place as a safety net when a tool call encounters an expiring token.
3. Successful refresh SHALL persist the updated token data back to `gauth.json` so both managed apps see the same refreshed state.
4. Each daemon startup SHALL trigger a silent background sweep for shared Google MCP token freshness.
5. Refresh success SHALL be reflected back into managed-app observability so the UI/status surface can see the new state without requiring a tool call.

## Scope

### IN

- Shared Google OAuth token refresh maintenance for Gmail and Google Calendar.
- Daemon-start background sweep for `gauth.json` tokens.
- State updates / logging that make token freshness observable.
- Validation around expiry handling and managed-app readiness.

### OUT

- Changing the Google OAuth consent flow or account binding model.
- Replacing the shared `gauth.json` storage contract.
- Adding unrelated MCP provider refresh logic.

## Non-Goals

- Reworking the managed app registry state machine.
- Introducing a new auth fallback path or silent rescue behavior.
- Making Gmail-specific auth separate from the shared Google token source.

## Constraints

- Must fail fast when refresh cannot proceed because credentials are missing or invalid.
- Must preserve the shared Google token store contract used by Gmail and Calendar.
- Must avoid duplicating refresh logic in each Gmail tool executor.

## What Changes

- A daemon-start background sweep will keep shared Google access tokens fresh before they expire.
- `gauth.ts` becomes the shared refresh coordination layer for proactive and on-demand refresh.
- Gmail / Google Calendar managed apps will consume fresher tokens without requiring manual re-auth every time expiry is near.

## Capabilities

### New Capabilities

- Proactive token refresh: keeps Google MCP tokens valid before the next user-visible tool call.
- Shared refresh maintenance: one background mechanism serves both Gmail and Calendar.

### Modified Capabilities

- Gmail tool execution: now benefits from background pre-refresh instead of relying only on late refresh at call time.
- Managed app readiness: token freshness can be observed independently from tool invocation.

## Impact

- `packages/opencode/src/mcp/apps/gauth.ts`
- `packages/opencode/src/mcp/apps/gmail/index.ts`
- `packages/opencode/src/mcp/app-registry.ts`
- `packages/opencode/src/mcp/index.ts`
- `docs/events/event_20260325_gmail-mcp.md`
