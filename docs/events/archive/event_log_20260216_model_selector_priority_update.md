# Event: Update Model Selector Failover Priority

**Date:** 2026-02-16
**Topic:** model-selector-priority-update

## Summary

Updated the `model-selector` skill to define a specific rotation/failover priority for providers.

## Changes

- Updated `Heterogeneous Failover` section in `.opencode/skills/model-selector/SKILL.md`.
- Set the priority sequence to:
  1. github-copilot
  2. gemini-cli
  3. gmicloud
  4. openai
  5. claude-cli

## Rationale

To ensure consistent failover behavior across different sessions and prioritize subscription-based or higher-quota resources correctly.
