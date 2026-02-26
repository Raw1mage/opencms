# Event: Batch-1 Phase B rewrite-port (session / SSE / state)

Date: 2026-02-26
Status: Done

## Scope

- Phase B candidate set:
  - `81b5a6a08` workspace reset
  - `ed472d8a6` session context metrics defensive defaults
  - `ff0abacf4` project icons unloading
  - `958320f9c` remote http server connections
  - `50f208d69` suggestion active state
  - `c9719dff7` notification navigate to session
  - `dd296f703` reconnect event stream on disconnect
  - `ebe5a2b74` remount SDK/sync tree when server URL changes

## Decision summary

- Integrated/no-op on current `cms` (already present):
  - `81b5a6a08`
  - `ed472d8a6`
  - `ff0abacf4`
  - `50f208d69`
  - `c9719dff7`
  - `dd296f703`
  - `ebe5a2b74`
- Ported in this phase:
  - `958320f9c` (remote HTTP event stream fetch path)

## Changes

- Updated `packages/app/src/context/global-sdk.tsx`
  - Added `streamFetch = eventFetch ?? fetchWithAuth`
  - Wired `eventSdk` to use `streamFetch` instead of always `fetchWithAuth`
  - Effect: for non-loopback `http:` server URLs with platform fetch available, event stream now uses platform fetch path; otherwise falls back to web-auth fetch.

## Validation

- `bun turbo typecheck --filter=@opencode-ai/app` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
- This phase intentionally minimized code churn: only missing behavior delta was applied.
