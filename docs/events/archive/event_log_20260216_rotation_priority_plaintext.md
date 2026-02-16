# Event: Plaintext Rotation Priority Parsing

**Date:** 2026-02-16
**Topic:** rotation-priority-plaintext

## Summary

Added a plain-text rotation priority parser that converts human-readable provider/account/model rules into rotation3d config.

## Changes

- Introduced shared instruction parsing helpers in `packages/opencode/src/session/instruction-policy.ts`.
- `score.ts` now uses the shared instruction JSON loader instead of duplicating AGENTS.md parsing.
- `rotation3d` can load a plaintext `opencode-rotation-priority` block and convert it into ordered priority rules.
- Priority rules now influence candidate scoring with rule specificity boosts and fuzzy token matching.

## Rationale

Allow rotation policy to be expressed in human-readable form while maintaining deterministic, persistent behavior across sessions.
