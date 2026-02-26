# Batch9B Restrict Alpha Models to Admin Workspaces (rewrite-only)

Date: 2026-02-27
Source: `origin/dev` (`f8cfb697bd10a328afab4e6a074148c2e651fcb2`)
Target: `cms`

## Scope

- Port model-access policy hardening for alpha models in Zen handler.

## Changes

1. `packages/console/app/src/routes/zen/util/handler.ts`
   - Added `Resource` import from `@opencode-ai/console-resource`.
   - Renamed workspace allowlist constant:
     - `FREE_WORKSPACES` -> `ADMIN_WORKSPACES`.
   - Added production-stage guard in `authenticate(modelInfo)`:
     - if model id starts with `alpha-` and workspace is not in `ADMIN_WORKSPACES`, return `AuthError`.
   - Updated `isFree` derivation to use `ADMIN_WORKSPACES` allowlist (behavior aligned with upstream policy rename).

## Validation

- Ran `bun run typecheck` in `packages/console/app` ✅

## Safety

- Change is constrained to zen auth/model access policy.
- No changes to provider split internals, rotation3d core flow, or account store mechanics.
