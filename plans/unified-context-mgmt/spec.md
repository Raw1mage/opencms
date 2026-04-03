# Spec: Unified Context Management

## Taxonomy

### Compaction Types

| ID | Name | Generator | Storage |
|----|------|-----------|---------|
| **A** | Server Service | Codex `/responses/compact` endpoint (free, server-side) | Dialog visible + Compaction anchor + Checkpoint file |
| **B** | LLM Request | LLM summarization agent call (token cost) | Dialog visible + Compaction anchor + Checkpoint file |
| **C** | Abstract Template | SharedContext side-channel (code-maintained, zero LLM cost) | Independent snapshot file only |
| **D** | Truncation | Hard cutoff from tail (no summary) | Nothing |

### Key Distinctions

- **A vs B**: A is only available when the active provider is Codex with a valid OAuth session. If A is unavailable or fails, fall through to B automatically. From the system's perspective they are interchangeable — both produce a dialog anchor and a checkpoint file.
- **A triggering**: Silent, background, multiple triggers (token threshold, continuation invalidated, cache-aware). Never shows as an explicit event in the dialog.
- **B triggering**: Explicit. Creates a visible boundary in the dialog. User can see that a compaction occurred.
- **C**: Always running. Not a compaction executor. Produces a snapshot file as a live digest of the session. Stored in the session's XDG path alongside dialog history. Never touches the dialog.
- **D**: Last resort only. Requires all of A/B to be unavailable AND context at emergency ceiling. Must `log.warn` with reason.

---

## Storage Contracts

### Checkpoint File (`rebind-checkpoint-{sessionID}.json`)

Produced by A or B after successful compaction.

```ts
interface RebindCheckpoint {
  sessionID: string
  timestamp: number
  source: "codex-server" | "llm"
  lastMessageId: string        // boundary: messages after this are "new"
  summary: string              // human-readable summary text
  opaqueItems?: unknown[]      // Codex-only: opaque output array for direct replay
}
```

Lifecycle:
- Written: after A or B compaction completes (non-blocking, background)
- Read: on session reload
- Deleted: after successful reload establishes a new continuation
- Pruned: files older than 24h are cleaned up on startup

### Abstract Template Snapshot (`{session-xdg-path}/abstract-template.json`)

Produced by C continuously in background. Stored inside each session's XDG directory alongside dialog history.

```ts
interface AbstractTemplateSnapshot {
  sessionID: string
  updatedAt: number
  content: string   // formatted SharedContext space (goal, files, discoveries, actions, currentState)
  tokenEstimate: number
}
```

Lifecycle:
- Written: after every turn where SharedContext is updated (replaces previous snapshot atomically)
- Read: informational only — NOT used to trigger B for old sessions (see REQ-3)
- Never deleted by compaction logic (owned by SharedContext lifecycle)
- Size: self-limiting via SharedContext budget (~8192 tokens max)

---

## Requirements

### REQ-1: Orphaned Tool Call Sanitize Pass

**Applies to: A, B, C, D — all paths before any context is sent to a provider.**

- **GIVEN** a message history being assembled for a provider request (reload or mid-session)
- **WHEN** the system finds a `function_call` with no matching `function_call_output`, or a `function_call_output` with no matching `function_call`
- **THEN** the unmatched item SHALL be replaced with a `[tool call invalidated]` plain-text placeholder
- **AND** the replacement SHALL only affect the in-memory context array, NOT the stored DB records
- **AND** the system SHALL `log.warn` listing each invalidated `call_id`

### REQ-2: Checkpoint Produced by A and B

- **GIVEN** A or B compaction completes successfully
- **WHEN** the compaction anchor is written to the dialog
- **THEN** the system SHALL also write a checkpoint file in the background (non-blocking)
- **AND** the checkpoint `source` field SHALL identify which generator produced it
- **AND** for `source=codex-server`, the checkpoint SHALL also store `opaqueItems`

### REQ-3: Session Reload Decision Tree

On session entry, the system SHALL follow this sequence:

```
1. Checkpoint file exists?
   ├─ YES, source=codex-server → inject opaqueItems as context prefix + tail messages after lastMessageId
   └─ YES, source=llm          → inject summary as synthetic context message + tail messages after lastMessageId
2. No checkpoint (legacy sessions, new sessions) →
   filterCompacted (traditional compaction anchor scan) + token budget guard (REQ-4)
3. Token guard exceeded → D (log.warn required)
4. Run sanitize pass (REQ-1) on final assembled message array
```

Note: sessions without a checkpoint SHALL NOT trigger B to build one retroactively.
The traditional compaction anchor is sufficient for backward compatibility.
The token budget guard (REQ-4) is the safety net against infinite context loading.

### REQ-4: filterCompacted Token Budget Guard

- **GIVEN** `filterCompacted` is scanning message history
- **WHEN** the accumulated estimated token count exceeds `model.limit.context * 0.7`
- **THEN** scanning SHALL stop at that point regardless of whether a compaction anchor was found
- **AND** the system SHALL attempt to trigger C → B to produce an anchor for next reload
- **AND** if B is unavailable, proceed with the truncated set (D path)

### REQ-5: Provider-Aware Compaction Routing

- **GIVEN** a compaction is needed
- **WHEN** the active provider is NOT Codex
- **THEN** the system SHALL skip A entirely and go directly to B
- **WHEN** the active model's context size is below threshold (< 16k) or is otherwise determined to lack summarization capability
- **THEN** the system SHALL skip B and go directly to D
- `canSummarize` is derived automatically from model metadata; no manual config required

### REQ-6: Abstract Template Runs Silently

- **GIVEN** any session turn completes
- **WHEN** SharedContext is updated
- **THEN** C SHALL write its snapshot file silently in background
- **AND** C SHALL NOT write any message to the dialog
- **AND** C SHALL NOT write a compaction anchor
- **AND** C SHALL NOT overwrite the checkpoint file

---

## Superseded Plans

| Plan | Status | Disposition |
|------|--------|-------------|
| `plans/20260330_rebind-checkpoint/` | Superseded | Core checkpoint concept absorbed. Codex-only scope expanded to all providers. |
| `plans/fix-rebind-checkpoint/` | Superseded | RCA findings absorbed. Defensive truncation replaced by REQ-4. |
