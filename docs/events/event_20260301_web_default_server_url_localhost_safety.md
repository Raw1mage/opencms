# Event: prevent web default server URL fallback to stale localhost

Date: 2026-03-01
Status: Done

## Symptom

- After self-restart in external-domain deployment (e.g. `crm.sob.com.tw`), UI could jump to a `http://localhost:1080/...` URL and then fail with `TypeError: Failed to fetch`.

## Root Cause

- Web app reads persisted default server URL from localStorage (`opencode.settings.dat:defaultServerUrl`).
- If that value is `localhost` from a previous local/dev session, startup can select it even when current page origin is a non-local domain.

## Change

- File: `packages/app/src/app.tsx`
- In `resolveDefaultServerUrl(...)`, add safety rule:
  - When current host is non-local and non-dev, ignore persisted localhost target and use current `window.location.origin`.

## Expected Outcome

- External deployments keep using current domain origin after reload/restart.
- Stale localhost preference no longer hijacks server target in production-like web usage.
