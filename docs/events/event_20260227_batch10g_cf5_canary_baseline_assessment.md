# Batch10G Canary baseline workflow assessment (rewrite-only decision)

Date: 2026-02-27
Source: `origin/dev` (`cf5cfb48c`)
Target: `cms`

## Scope

- Assess upstream canary-baseline migration commit without forcing unstable toolchain policy changes into cms.

## Assessment

`cf5cfb48c` introduces a broad policy shift to canary Bun binaries and cross-compile pre-caching, spanning:

- `.github/actions/setup-bun/action.yml` (composite action interface/behavior changes)
- publish/sign workflows invoking the action
- desktop build utilities and opencode build script expectations

Current cms strategy already includes baseline download URL handling and Windows matrix hardening while keeping package-manager-pinned Bun for stability. Adopting canary + cross-target cache prewarming would materially change CI reproducibility and failure profile.

## Decision

- Mark `cf5cfb48c` as **skipped** for now (policy divergence).
- Keep existing cms baseline/stability balance.

## Follow-up

- Revisit in a dedicated infra experiment branch if segmentation-fault pressure returns and canary policy is explicitly approved.
