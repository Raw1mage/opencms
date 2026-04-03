# Design: Unified Context Management

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Session Turn (mid-session)                             │
│                                                         │
│  prompt.ts                                              │
│    ├─ A/B trigger check (overflow / cache-aware / idle) │
│    │    └─ A (Codex only) → fails → B                  │
│    │         └─ write dialog anchor                     │
│    │         └─ write checkpoint file (background)      │
│    └─ C update (always, background)                     │
│         └─ write abstract-template snapshot             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Session Reload                                         │
│                                                         │
│  1. checkpoint lookup                                   │
│       ├─ found (codex) → opaque items prefix + tail     │
│       ├─ found (llm)   → summary message + tail         │
│       └─ not found → filterCompacted + token guard      │
│              └─ token guard exceeded → D (log.warn)     │
│  2. sanitize pass (orphaned tool call cleanup)          │
└─────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### `session/compaction.ts`

- Owns A and B trigger logic (overflow, cache-aware, idle, continuationInvalidated)
- Owns checkpoint file write/read/delete/prune
- Owns `compactWithSharedContext` (renamed: `compactWithAbstractTemplate`) — now only called when C snapshot is used as B input during reload
- **New**: `saveCheckpointFromCompaction(source, summary, opaqueItems?)` — unified post-compaction checkpoint writer called by both A and B paths
- **New**: `sanitizeOrphanedToolCalls(messages)` — returns cleaned in-memory array, does not touch DB

### `session/message-v2.ts`

- `filterCompacted`: add token budget accumulator, stop at 70% model context limit
- Emit a signal (or return a flag) when stopped by budget rather than by anchor, so caller can trigger B

### `session/shared-context.ts`

- **New**: `persistSnapshot(sessionID)` — writes `abstract-template-{sessionID}.json` after each turn
- Existing `snapshot()` function stays for in-memory reads

### `session/prompt.ts`

- Session reload assembly (step 1 in the overview) moves here from scattered locations
- Reads checkpoint → assembles prefix + tail
- Falls back to C snapshot → triggers B if needed
- Calls `sanitizeOrphanedToolCalls` before final assembly
- **Remove**: Codex-specific `continuationInvalidated` as the sole reload trigger — reload logic is now provider-agnostic

## Trigger Condition Table (Final)

| Condition | A (Codex Server) | B (LLM request) | C (Abstract Template) | D (Truncation) |
|-----------|-----------------|-----------------|----------------------|----------------|
| **Available when** | Codex provider + valid OAuth | `model.canSummarize` | Always | Always |
| **Overflow trigger** | ✓ (same thresholds as B) | by-token: count ≥ context−80k; by-request: ~disabled | — | emergency: count ≥ context−2k |
| **Cache-aware trigger** | ✓ | usage ≥ 40% + hit rate < 40% + input ≥ 40k | — | — |
| **Idle trigger** | ✓ | by-token: usage ≥ 60%; by-request: disabled | — | — |
| **Continuation invalidated** | ✓ | ✓ (if A unavailable) | — | — |
| **Every turn** | — | — | ✓ (silent) | — |
| **Reload: checkpoint missing + C present** | — | ✓ (triggered to rebuild checkpoint) | provides snapshot as input | — |
| **Reload: all else fails** | — | — | — | ✓ (log.warn) |
| **Cooldown** | none (event-driven) | by-token: 4 rounds; by-request: 8 rounds; emergency: none | none | none |
| **Dialog visible** | ✓ | ✓ | ✗ | ✗ |
| **Compaction anchor** | ✓ | ✓ | ✗ | ✗ |
| **Checkpoint file** | ✓ (post-compaction) | ✓ (post-compaction) | ✗ | ✗ |
| **Abstract template snapshot** | ✗ | ✗ | ✓ | ✗ |
| **Orphaned tool call sanitize** | ✓ (pre-send) | ✓ (pre-send) | — | ✓ (pre-send) |

## Checkpoint File Format (Extended)

```ts
interface RebindCheckpoint {
  sessionID: string
  timestamp: number
  source: "codex-server" | "llm"
  lastMessageId: string
  summary: string
  opaqueItems?: unknown[]   // codex-server only
}
```

Reload behavior by source:
- `codex-server`: use `opaqueItems` directly as Responses API input prefix (skip message conversion for pre-boundary messages)
- `llm`: inject `summary` as a synthetic user message `"[Context summary]\n{summary}"` followed by post-boundary messages

## Orphaned Tool Call Sanitize Pass

```ts
function sanitizeOrphanedToolCalls(messages: ModelMessage[]): ModelMessage[] {
  // 1. collect all call_ids from function_call items
  // 2. collect all call_ids from function_call_output items
  // 3. for each unmatched call_id in either set:
  //    replace the item with { role: "tool", content: "[tool call invalidated: {call_id}]" }
  // 4. log.warn listing invalidated call_ids
  // 5. return cleaned array (original messages untouched)
}
```

This runs on the final assembled ModelMessage array, after checkpoint/tail merge, before the array is sent to the provider.

## Critical Files

| File | Changes |
|------|---------|
| `session/compaction.ts` | Add `saveCheckpointFromCompaction`, `sanitizeOrphanedToolCalls`; A and B both call checkpoint writer |
| `session/prompt.ts` | Unify reload assembly; provider-agnostic checkpoint lookup; call sanitize pass |
| `session/message-v2.ts` | Add token budget guard to `filterCompacted` |
| `session/shared-context.ts` | Add `persistSnapshot` for C snapshot file |
