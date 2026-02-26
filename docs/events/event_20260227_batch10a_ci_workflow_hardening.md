# Batch10A CI workflow hardening (rewrite-only)

Date: 2026-02-27
Source: `origin/dev` (`24c63914b`, `0269f39a1`, `ae190038f`)
Target: `cms`

## Scope

- Port low-risk CI/workflow automation improvements.

## Changes

1. `.github/workflows/compliance-close.yml`
   - After auto-close action, remove `needs:compliance` label best-effort.
2. `.github/workflows/pr-standards.yml`
   - Relax linked-issue requirement by skipping issue check for `feat` PR titles (in addition to `docs`/`refactor`).
3. `.github/workflows/test.yml`
   - Expand `unit` job to Linux + Windows matrix.
4. `.github/actions/setup-bun/action.yml`
   - Add baseline Bun download URL resolver step for x64 runners.
   - Wire resolved URL into `oven-sh/setup-bun` via `bun-download-url`.

## Validation

- Structural/config updates only; no repo runtime code touched.
- Verified YAML edits and repo status via git diff/status.

## Safety

- No impact to cms runtime domains (multi-account, rotation3d, admin, provider split).
