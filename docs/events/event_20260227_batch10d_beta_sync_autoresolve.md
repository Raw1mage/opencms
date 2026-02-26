# Batch10D Beta sync auto-resolve automation (rewrite-only)

Date: 2026-02-27
Source: `origin/dev` (`a487f11a3`, `0b3fb5d46`, `6af7ddf03`)
Target: `cms`

## Scope

- Port CI beta-sync conflict auto-resolution flow and model pinning.
- Adapt upstream `script/beta.ts` path to cms layout (`scripts/beta.ts`).

## Changes

1. `.github/workflows/beta.yml`
   - Added OpenCode CLI install step (`bun i -g opencode-ai`).
   - Added `OPENCODE_API_KEY` env for sync step.
   - Updated script path to `bun scripts/beta.ts`.
2. `scripts/beta.ts`
   - Added helpers:
     - `conflicts()` to detect unresolved files.
     - `cleanup()` to abort/recover rebase/merge state.
     - `run(args)` for argv-safe command execution.
     - `fix(pr, files)` to invoke `opencode run` for conflict resolution.
   - Rebase failure flow now attempts auto-resolve before skipping PR.
   - Model pin set to `opencode/gpt-5.3-codex` (latest upstream in sequence).

## Validation

- Script/workflow logic update only; no runtime product code touched.
- Verified changes via git diff and structure checks.

## Safety

- Changes are isolated to beta sync CI automation path.
- No impact on cms runtime domains (multi-account, rotation3d, admin, provider split).
