# Event: Quota Usage Determination Refactoring

Date: 2025-02-15
Topic: Refactoring 429 Rate Limit detection and rotation logic with 3D statistics.

## Status

- [x] ANALYSIS: Identified redundant rotations caused by model-only rate limiting.
- [x] PLANNING: Designed a 3D (Provider, Account, Model) statistics tracker.
- [x] EXECUTION: Implemented daily counter with 16:00 Asia/Taipei reset and RPM-conflict detection.

## Problem Description

The previous system suffered from "bounce-back" rotations where a quota-exhausted account would trigger multiple rapid rotations within the same account because it only marked the specific model as limited. Additionally, there was no way to distinguish between short-term RPM (Requests Per Minute) and long-term RPD (Requests Per Day) for Google Gemini API.

## Proposed Solution

1. **3D Consistency**: All health and rate-limit tracking must use the triplet `(provider, account, model)`.
2. **Absolute Daily Counter**: Persist request counts in `rotation-state.json` and reset them at 16:00 Asia/Taipei (UTC 08:00), matching Google's observed reset cycle.
3. **RPM Conflict Detection (Strict RPD)**: If a 429 error occurs when the tracked RPM is below the known constant limit, automatically promote the error to RPD.
4. **Dynamic Cooldown**: Set the cooldown duration to exactly the remaining time until the next 16:00 Taipei reset for RPD events.
5. **Admin Panel Integration**: Display `${current}/${limit}` in the Model Activities list for better visibility.

## Impacted Components

- `packages/opencode/src/account/monitor.ts`: Added constant limits and 3D status calculation.
- `packages/opencode/src/account/rotation.ts`: Added quota day reset logic and daily counter management.
- `packages/opencode/src/session/llm.ts`: Main logic for 429 handling and strict RPD detection.
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`: UI visualization.

## Verification Results

- System now correctly identifies RPD when a fresh model gets 429 immediately.
- Cooldown timer in Admin Panel correctly counts down to 16:00 Taipei.
- Rotation no longer gets stuck in a loop within the same exhausted Google account.

## References

- @event_20260215_quota_stats_refactor
- @event_20260215_strict_rpd
