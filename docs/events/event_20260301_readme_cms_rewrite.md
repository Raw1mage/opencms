# Event: rewrite root README as cms architecture overview

Date: 2026-03-01
Status: Done

## Scope

- Replace root `README.md` with a cms-focused version.
- Emphasize system architecture and core product features.

## Changes

1. Removed upstream-style marketing/install-centric README content.
2. Rebuilt README around cms branch intent:
   - Global multi-account management
   - Rotation3D routing/fallback
   - TUI `/admin` as canonical control plane
   - Provider split (`antigravity` / `gemini-cli` / `google-api`)
3. Added architecture section with layered view:
   - Interface layer
   - Runtime/API layer
   - Provider/Account layer
   - Plugin/Capability layer
4. Added key design principles and branch integration policy.
5. Kept a minimal development verification section and links to deeper docs.

## Rationale

- Align first-entry documentation with actual cms runtime architecture and operational model.
- Reduce mismatch between repository landing docs and current product-line priorities.
