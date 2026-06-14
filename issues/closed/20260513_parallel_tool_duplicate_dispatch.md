# Bug Report: Parallel tool wrapper can duplicate identical actions

Status: Resolved (closed 2026-05-29; d21a6fd79)

## Summary

During the compaction duplicate-actions implementation, a `multi_tool_use.parallel` call contained two identical `apply_patch` actions for the same file. The runtime accepted the batch and executed at least one write-class action, creating unsafe duplicate-dispatch pressure on an issue whose core symptom is duplicate tool actions.

## Impact

- Write-class tools can be accidentally dispatched more than once in the same assistant turn.
- `apply_patch` may mutate state before the agent can observe the duplicate request.
- Agents may interpret the resulting state as tool/read inconsistency and retry again.

## Reproduction Evidence

- Session: `ses_1debd25f5ffe1zt6FfZuw66Ltf`
- File touched: `packages/opencode/src/session/post-compaction.ts`
- Trigger: `multi_tool_use.parallel` with two identical `functions.apply_patch` entries for the same target file.

## Expected Behavior

The tool layer should reject or serialize duplicate write-class operations to the same file in one parallel batch, with an explicit error explaining the conflict.

## Suggested Fix

- Add batch-level duplicate detection for write-class tools keyed by target file path and operation type.
- Reject conflicting parallel writes before executing any mutation.
- Include deterministic provenance in the error: batch index, tool name, target path.

## Acceptance Criteria

- Identical parallel write actions to the same file fail before mutation.
- Independent read/search actions remain parallelizable.
- A regression test covers duplicate `apply_patch` entries in one parallel batch.
