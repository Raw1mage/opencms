# Tasks: Unified Context Management

## Phase 1 — Sanitize Pass (P0, unblocks paralyzed sessions)

### T1.1 Implement `sanitizeOrphanedToolCalls`
- Location: `session/compaction.ts`
- Input: `ModelMessage[]`
- Behavior: collect call_ids from `function_call` and `function_call_output` items; replace unmatched items with plain-text placeholder; `log.warn` listing invalidated call_ids
- Output: cleaned `ModelMessage[]` (original untouched)

### T1.2 Wire sanitize pass into prompt assembly
- Location: `session/prompt.ts`
- Call `sanitizeOrphanedToolCalls` on final assembled message array before any provider request (both mid-session and reload paths)

---

## Phase 2 — filterCompacted Token Budget Guard

### T2.1 Add token accumulator to `filterCompacted`
- Location: `session/message-v2.ts`
- Accumulate estimated tokens (`.length / 4`) per message
- Stop scanning when accumulator exceeds `model.limit.context * 0.7`
- Return flag `stoppedByBudget: boolean` alongside message array

### T2.2 Handle `stoppedByBudget` in reload path
- Location: `session/prompt.ts`
- If `stoppedByBudget`, attempt to trigger B compaction to produce an anchor
- If B unavailable, proceed with truncated set and `log.warn`

---

## Phase 3 — Unified Checkpoint (A and B both write checkpoint)

### T3.1 Extend `RebindCheckpoint` interface
- Add `source: "codex-server" | "llm"`
- Add `opaqueItems?: unknown[]`

### T3.2 Extract `saveCheckpointFromCompaction`
- Location: `session/compaction.ts`
- Called by both A and B after successful compaction
- Non-blocking (fire-and-forget)

### T3.3 Wire checkpoint save into B (LLM compaction) path
- After `compactWithLLM` completes, call `saveCheckpointFromCompaction`

### T3.4 Wire checkpoint save into A (Codex server) path
- After `codexServerCompact` completes, call `saveCheckpointFromCompaction` with `opaqueItems`

---

## Phase 4 — Provider-Agnostic Session Reload

### T4.1 Abstract Template snapshot persistence
- Location: `session/shared-context.ts`
- Add `persistSnapshot(sessionID)`: write `abstract-template.json` inside session's XDG path (alongside dialog history) after each turn
- Atomic write (tmp → rename)

### T4.2 Unify reload assembly in `prompt.ts`
- Remove Codex-only `continuationInvalidated` as sole reload trigger
- Implement decision tree:
  1. Checkpoint exists → inject prefix (opaqueItems or summary) + tail messages after `lastMessageId`
  2. No checkpoint → filterCompacted (traditional compaction anchor scan) + token guard (T2.1)
  3. Token guard exceeded → D with `log.warn`
  4. All paths call sanitize pass (T1.2) on final assembled array
- Legacy sessions (no checkpoint) use traditional compaction anchor — do NOT trigger B retroactively

---

## Phase 5 — Provider Routing

### T5.1 Add `canSummarize` to model capability
- Source: derive from model context size or explicit config flag
- Models with context < 16k or known low-capability: `canSummarize = false`

### T5.2 Wire capability check into compaction routing
- If provider ≠ Codex: skip A, go to B
- If `canSummarize === false`: skip B, use C snapshot as B input or go to D

---

## Acceptance Checks

- [ ] A paralyzed session (orphaned tool call) can be re-entered and responds normally after sanitize pass
- [ ] A session with 440+ messages and no checkpoint loads without OOM (token guard fires)
- [ ] After B compaction, a checkpoint file exists on disk
- [ ] After A compaction, a checkpoint file exists with `opaqueItems`
- [ ] Session reload on non-Codex provider uses checkpoint correctly
- [ ] C snapshot file is updated after each turn, never appears in dialog
- [ ] D fallback always emits `log.warn` with reason
