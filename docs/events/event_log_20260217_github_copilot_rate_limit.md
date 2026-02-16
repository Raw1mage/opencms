# Event: GitHub Copilot Rate Limit Misclassification

**Date**: 2026-02-17
**Topic**: Rate Limit Handling / Model Status

## Situation

The user reported that the `github-copilot` provider hit its monthly rate limit.
However, the system treated this as a generic failure or invalid model state, potentially causing it to be removed from the "favorites" or active list.

## Observation

- Provider: `github-copilot`
- Error Type: Monthly Rate Limit Exceeded
- System Behavior: Misclassified as model failure/invalidity.

## Impact

- High-value models from GitHub Copilot are unavailable or deprioritized incorrectly.
- User has to manually intervene to restore them or wait until next month without clear status indication.

## Action Items

1. [x] Log this event for future debugging.
2. [ ] Future Work: Refine error handling to distinguish between "Monthly Quota Exceeded" (Long Cooldown) and "Model Invalid" (Removal).
