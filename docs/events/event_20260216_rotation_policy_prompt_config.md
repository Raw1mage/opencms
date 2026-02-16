# Event: Rotation Policy Config via AGENTS.md

**Date:** 2026-02-16
**Topic:** rotation-policy-prompt-config

## Summary

Added a configurable rotation policy loader for the 3D rotation system that reads a JSON block from AGENTS.md and applies it to rate-limit fallback selection.

## Changes

- Added `resolveRotation3DConfig` to merge defaults with an `opencode-rotation3d` block from AGENTS.md.
- Provider priority weighting now influences candidate scoring during rate-limit rotation.
- Updated `/rotation/fallback` route to use the resolved config instead of hardcoded defaults.
- Documented the policy block in `.opencode/AGENTS.md`.

## Rationale

Allow rotation policy to be driven by system prompt configuration rather than hardcoded logic or favorite order, while keeping behavior consistent across sessions.
