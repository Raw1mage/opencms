# Handoff: Unified Context Management

## Status
PLANNING_COMPLETE — ready for implementation agent.

## Supersedes
- `plans/20260330_rebind-checkpoint/` — checkpoint concept absorbed, scope expanded
- `plans/fix-rebind-checkpoint/` — RCA findings absorbed, fix approach replaced

## Key Decisions (do not revisit without user confirmation)

1. **A only for Codex provider.** All other providers go directly to B.
2. **A is silent / B is explicit.** A triggers in background without dialog change. B produces a visible compaction boundary.
3. **C is not a compaction executor.** It is a background side-channel that produces a snapshot file. It never writes dialog messages or compaction anchors.
4. **Checkpoint is shared infrastructure.** Both A and B write a checkpoint after completion. Checkpoint format includes `source` and optional `opaqueItems` for Codex replays.
5. **Sanitize pass is pre-send, not pre-store.** Orphaned tool call cleanup is in-memory only — DB records are never modified.
6. **D requires explicit log.warn.** Truncation must never be silent. This is AGENTS.md Rule 1.

## Implementation Order
Phase 1 (T1) → Phase 2 (T2) → Phase 3 (T3) → Phase 4 (T4) → Phase 5 (T5)

Phase 1 is the highest priority — it unblocks currently paralyzed sessions without touching compaction logic.

## Resolved Decisions

7. **`canSummarize` is auto-derived.** No manual config. Models with context < 16k or known low-capability skip B and go to D.
8. **C snapshot path is session-scoped XDG.** Stored inside each session's XDG directory alongside dialog history, NOT in `Global.Path.state`.
9. **Legacy sessions do NOT get B-rebuilt checkpoints.** Sessions without a checkpoint use the traditional compaction anchor via `filterCompacted`. No LLM cost for old sessions. Token budget guard (REQ-4) is the safety net for abnormal sessions that would otherwise OOM.
