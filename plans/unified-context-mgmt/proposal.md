# Proposal: Unified Context Management

## Background

Three overlapping plans (`20260330_rebind-checkpoint`, `fix-rebind-checkpoint`, and ad-hoc compaction work) each address a fragment of the same problem. This plan supersedes all three and establishes a single coherent model.

## Problem

1. **Session paralysis**: Orphaned tool call pairs (unmatched `function_call` / `function_call_output`) cause the Responses API to permanently reject requests. No sanitization exists anywhere in the pipeline.
2. **Reload OOM**: `filterCompacted` has no token budget guard. Sessions without a compaction anchor load all messages until context window explodes.
3. **Compaction results are disposable**: Codex Server (A) and LLM (B) compaction produce high-quality summaries at real cost, but results live only in the dialog anchor and cannot be reused on session reload.
4. **No capability-aware routing**: The system has no path for low-capability models that cannot do LLM summarization.
5. **Rebind is Codex-only**: The existing checkpoint/rebind mechanism only activates on `continuationInvalidated` (a Codex WS event), leaving all other providers without any reload optimization.

## Goals

- Define a unified ABCD compaction taxonomy with clear responsibilities, trigger conditions, and storage contracts.
- Unify session reload under a single decision tree that works for all providers.
- Establish a sanitize pass that prevents orphaned tool calls from reaching any provider.
- Checkpoint becomes a shared artifact produced by A and B, not a Codex-only concept.
- Abstract Template (C) is a silent background side-channel, not a compaction executor.

## Non-Goals

- Replacing the existing overflow compaction trigger logic wholesale.
- Changing the SharedContext data model.
- Any UI changes.
