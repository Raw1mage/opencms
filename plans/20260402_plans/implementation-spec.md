# Implementation Spec

## Goal

- Deliver a planning-complete implementation blueprint for dialog continuation reset/rebuild that:
  1. Uses **A-trigger-only** flush policy.
  2. Uses **checkpoint prefix + raw tail steps** replay composition.
  3. Emits structured debug logs with **full state snapshot + redaction** when invalidation errors (including `text part msg_* not found`) occur.

## Scope

### IN

- Define continuation reset/rebuild contract across all known triggers (A1..A5).
- Enforce execution identity boundary as `providerId + modelID + accountId`.
- Define flush scope as provider remote continuity only (refs/sticky state), not local semantic assets.
- Define replay composition contract: checkpoint replaces compacted prefix; uncompacted segment remains raw tail replay.
- Define full-state debug logging schema for invalidation failures via existing runtime logger.
- Keep first build slice targeted at Codex/OpenAI Responses path, with provider-hook-ready design.

### OUT

- Runtime code changes in this planning step.
- New fallback mechanism that silently keeps stale refs.
- New debug transport/event channel in this slice.
- Checkpoint storage format redesign.

## Assumptions

- Execution identity is first-class and account-aware.
- Checkpoint contains local semantic compression and is safe to reuse across reset/rebuild when remote continuity is untrusted.
- Remote continuity state may exist in multiple provider-owned surfaces (metadata, sticky turn state, adapter caches, websocket/session state).
- `msg_*` semantics are provider-specific (Codex/OpenAI Responses), not universal.

## Contract Decisions (Authoritative)

- **CD-1 (Flush Decision):** `flushRemoteRefs = any(A1, A2, A3, A4, A5)`.
- **CD-2 (No B Section):** No separate "keep conditions" policy is defined.
- **CD-3 (Replay Composition):** `replayPayload = checkpointPrefix + rawTailSteps`.
- **CD-4 (Flush Scope):** Clear provider-issued remote refs/sticky continuity only; keep checkpoint/tail semantic assets.
- **CD-5 (Observability):** Invalidation failures must produce structured full-state snapshot logs through existing runtime logger.

## A-trigger Set

- **A1 Identity changed**: any of provider/model/account changes.
- **A2 Provider invalidation**: `previous_response_not_found`, `text part msg_* not found`, or equivalent adapter-level invalidation signal.
- **A3 Restart resume mismatch**: restart path cannot prove local/remote continuation alignment.
- **A4 Checkpoint rebuild untrusted**: rebuild boundary cannot prove remote-ref safety.
- **A5 Explicit reset**: operator/user requests continuation reset.

## Replay Composition Semantics

### Rule
`replayPayload = checkpointPrefix + rawTailSteps`

### Example
- Total steps: `1..16`
- Checkpoint compacted prefix: `1..10`
- Raw tail (uncompacted): `11..16`
- Outbound replay: `checkpoint(1..10) + raw(11..16)`

## Debug Log Contract (Full Snapshot + Redaction)

### Emit Condition
- Any classified continuation invalidation error, including `text part msg_* not found`.

### Sink
- Existing runtime logger (no new channel in this slice).

### Required Structured Fields

- Correlation
  - `traceId` / request correlation id (if available)
- Identity
  - `providerId`, `modelID`, `accountId`
- Trigger evaluation
  - `A1..A5` booleans
  - `matchedTriggers[]`
  - `flushRemoteRefs` (final decision)
- Checkpoint/tail boundaries
  - `checkpointStart`, `checkpointEnd`, `checkpointStepCount`
  - `tailStart`, `tailEnd`, `tailStepCount`
- Replay summary
  - `compositionType = checkpoint_plus_tail`
  - serializer input shape summary (counts/types only)
- Provider invalidation
  - normalized error code/category
  - message excerpt
- Provider continuity state summary
  - sticky/remote key presence + counts + age markers
- Flush result
  - cleared key set summary
  - post-flush continuity summary

### Redaction Rules

- MUST NOT log secrets, API keys, auth headers, raw credential blobs, or full request payload text.
- Log shape/count/ids summary only where sensitive content may exist.

## Stop Gates

- Stop if any proposed implementation discards local semantic context instead of only remote continuity.
- Stop if provider adapter cannot define safe flush scope (needs explicit decision).
- Stop if logging requirements conflict with privacy/redaction constraints.
- Replan if checkpoint schema redesign becomes necessary.

## Critical Files

- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/session/user-message-persist.ts`
- `packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.ts`
- `packages/opencode/src/provider/sdk/copilot/responses/openai-responses-language-model.ts`
- `packages/opencode/src/plugin/codex.ts`
- `packages/opencode/src/plugin/codex-websocket.ts`

## Build-Phase Execution Plan (for later handoff)

- **Phase 1:** Implement A-trigger evaluation and flush decision surface.
- **Phase 2:** Implement Codex/OpenAI remote continuity cleanup mapping.
- **Phase 3:** Implement checkpoint+tail replay composition path.
- **Phase 4:** Implement invalidation full-snapshot logger with redaction.
- **Phase 5:** Add unit-test-first coverage matrix and verify no same-identity regressions.

## Validation Matrix (Unit-test-first)

- `flush_on_identity_change_provider_model_account`
- `flush_on_provider_invalidation_previous_response_not_found`
- `flush_on_provider_invalidation_msg_not_found`
- `flush_on_restart_resume_mismatch`
- `flush_on_checkpoint_rebuild_untrusted`
- `flush_on_explicit_reset`
- `no_flush_when_no_trigger_matched`
- `replay_builds_checkpoint_plus_tail_steps`
- `flush_clears_only_remote_refs_not_checkpoint_or_tail`
- `invalidation_log_contains_full_state_snapshot`
- `invalidation_log_redacts_sensitive_fields`

## Handoff Criteria for plan_exit

Plan is eligible for `plan_exit` when:

1. `implementation-spec.md`, `spec.md`, `design.md`, `tasks.md` are semantically aligned.
2. A-trigger-only policy is consistent across all artifacts.
3. checkpoint+tail replay semantics are explicit and example-backed.
4. full-state + redaction logging contract is explicit and testable.
5. No artifact introduces silent fallback behavior.
