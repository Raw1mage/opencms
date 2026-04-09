# Design: Context Dispatch Optimization

## Context

- V2 context sharing prepends full parent history at child startup (avg 100K tokens). For Anthropic/Gemini this is cheap (content cache hit). For Codex it's expensive (full cache write — Responses API is state-reference, not content-based).
- Rebind checkpoint: LLM summary + lastMessageId boundary, 40K token threshold, 10-round cooldown. Designed for daemon restart recovery; repurposable for subagent dispatch.

## Goals / Non-Goals

**Goals:**

- Eliminate Codex subagent first-round cache write via previousResponseId fork
- Reduce non-Codex subagent first-round cost when checkpoint is available

**Non-Goals:**

- Unify cache behavior across all providers
- Modify Anthropic/Gemini dispatch path

## Decisions

- **DD-1: Codex fork is provider-gated.** Only `providerId === "codex"` triggers fork dispatch. Anthropic/Gemini continue to use stable prefix (already efficient). Check in `task.ts` at dispatch time.

- **DD-2: Fork seed via codexSessionState exposure.** `llm.ts` `codexSessionState` is currently module-private. Expose a read-only `LLM.getCodexResponseId(sessionID): string | undefined` function. `task.ts` reads this before spawning child session.

- **DD-3: parentMessagePrefix skip is conditional.** In `prompt.ts`, child session startup checks: if `session.parentID` AND `codexForkResponseId` is seeded in child's `codexSessionState` → skip parentMessagePrefix injection for this session. After first round, child builds its own chain normally.

- **DD-4: Checkpoint dispatch is opportunistic, not blocking.** `loadRebindCheckpoint()` is called at dispatch time. If found, used as prefix base. If not, fall back to full history (log reason). No on-demand checkpoint trigger at dispatch time.

## Data / Control Flow

**Codex Fork Path:**
```
task() dispatch
  → LLM.getCodexResponseId(parentSessionID) → R_N
  → child session created with codexForkResponseId = R_N
  → prompt.ts child startup: parentMessagePrefix skipped
  → llm.ts first call: previousResponseId = R_N injected
  → child builds own chain: C_1 → C_2 → ...
  → on completion: child checkpoint summary → parent continuation message
```

**Checkpoint Dispatch Path (non-Codex):**
```
task() dispatch
  → SessionCompaction.loadRebindCheckpoint(parentSessionID)
  → if found: parentMessagePrefix = [summary msg + messages after lastMessageId]
  → if not found: parentMessagePrefix = full parent history (existing)
  → rest of child lifecycle unchanged
```

## Risks / Trade-offs

- **Codex fork hash mismatch on first round**: child system prompt differs from parent. Need `FORK_SEED_SENTINEL` to bypass hash check for seeded responseId on first call.

- **Checkpoint summary completeness for subagent**: summary was designed for daemon restart, not subagent dispatch. May lack context an executor-type subagent needs. Mitigated: checkpoint dispatch is opportunistic fallback, executor should receive spec directly.

## Critical Files

- `packages/opencode/src/tool/task.ts` — dispatch logic, Codex fork seed
- `packages/opencode/src/session/prompt.ts` — parentMessagePrefix skip condition
- `packages/opencode/src/session/llm.ts` — codexSessionState exposure, first-call hash bypass
- `packages/opencode/src/session/compaction.ts` — loadRebindCheckpoint reuse at dispatch
