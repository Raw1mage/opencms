# Batch9A Remove Alpha Models from Zen Models Endpoint (rewrite-only)

Date: 2026-02-27
Source: `origin/dev` (`5190589632c97b570bb6f9035aa5c80c0fe833e7`)
Target: `cms`

## Scope

- Port low-risk model-governance change to Zen models listing endpoint.

## Change

1. `packages/console/app/src/routes/zen/v1/models.ts`
   - Added explicit filter to exclude alpha models from public list response:
     - `.filter(([id]) => !id.startsWith("alpha-"))`

## Validation

- Ran `bun run typecheck` in `packages/console/app` ✅

## Safety

- Change is endpoint listing filter only.
- No mutation to provider split, multi-account state, rotation3d logic, or admin core flows.
