# Refactoring Plan: 2026-02-09

## Summary

- Total Commits to process: 4 (Phase 1 Focus)
- Strategy: Manual Porting (High Risk items)
- Goal: Sync core Provider/Session logic and TUI fixes from origin/dev while respecting cms architecture.

## Actions

| Commit      | Action      | Notes                                                           |
| :---------- | :---------- | :-------------------------------------------------------------- |
| `99ea1351c` | Manual Port | ContextOverflowError integration in message-v2.ts and retry.ts. |
| `fde0b39b7` | Manual Port | Fix URL encoding in TUI components.                             |
| `0cd52f830` | Verified    | DashScope enable_thinking already present in transform.ts.      |
| `a25cd2da7` | Verified    | GPT-5 reasoningSummary already present in transform.ts.         |

## Execution Queue

1. [ ] Port `ContextOverflowError` to `src/session/message-v2.ts`.
2. [ ] Port `ContextOverflowError` check to `src/session/retry.ts`.
3. [ ] Sync SDK types in `packages/sdk/js/src/v2/gen/types.gen.ts`.
4. [ ] Port URL encoding fixes to `src/cli/cmd/tui/` and related files from `fde0b39b7`.
5. [ ] Run `bun test` to verify message serialization.

## Key Decisions (Interactive)

- **Manual Port**: Confirmed for high-risk items to handle path flattening.
- **SDK Sync**: Confirmed to maintain type safety across the project.
- **Naming Convention**: Confirmed to use `providerId` (cms style) over `providerID`.
