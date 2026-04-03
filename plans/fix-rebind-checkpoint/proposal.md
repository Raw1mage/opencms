# Proposal

## Why
- Legacy sessions with 440+ messages (850KB+) cause daemon stalls because no shadow checkpoint exists.
- The existing mechanism in `compaction.ts` is dormant for these sessions due to threshold calculation errors.

## Original Requirement Wording (Baseline)
- "對於找不到compaction邊界就一直讀大量資訊這件事，邏輯是有問題的... 對於不正常session內容要有一點容錯能力。"

## Requirement Revision History
- 2026-03-30: Original RebindCheckpoint design.
- 2026-04-03: Added "Legacy Gap Restoration" to handle existing heavy sessions via defensive truncation.

## Effective Requirement Description
1. Implement a defensive truncation gate for sessions > 150 messages without checkpoints.
2. Bridge the missing Shadow artifacts for old sessions via forced background healing.

## Scope
### IN
- Defensive truncation logic in `filterCompacted`.
- Synthetic context injection in `prompt.ts`.
- Forced background checkpointing for legacy visits.

### OUT
- Modifying the primary database message chain.
- Changing the 80K preventive threshold for active sessions.

## Impact
- Payload drops from 850KB to <200KB for legacy users.
- Sub-second TUI response time for established heavy sessions.
