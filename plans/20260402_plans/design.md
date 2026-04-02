# Design: dialog continuation checkpoint reuse and remote ref flush

## Context

- `text part msg_* not found` is OpenAI/Codex-style Responses remote-reference invalidation, not a universal provider protocol.
- Continuation failures can happen on identity switch and also on non-identity reset boundaries.
- Checkpoint/compaction already provides local semantic compression that can be reused safely.
- User requires complete on-error state snapshots in debug logs for later tracing.

## Goals / Non-Goals

**Goals**
- Enforce a single trigger-driven flush policy (A-trigger-only).
- Preserve local semantic continuity while removing stale remote refs.
- Define replay composition as `checkpointPrefix + rawTailSteps`.
- Keep provider cleanup ownership inside adapters.
- Emit structured, complete debug logs on invalidation failures via existing logger.

**Non-Goals**
- Introduce separate B keep-condition policy.
- Treat `msg_*` as cross-provider standard.
- Preserve cross-account remote continuity.
- Add a new debug event channel in this slice.

## Decisions

- **DD-1: Execution identity boundary** = `providerId + modelID + accountId`.
- **DD-2: Flush decision model** = A-trigger-only (`any(A1..A5)`).
- **DD-3: Replay composition model** = checkpoint replaces compacted prefix only; uncompressed tail remains raw replay.
- **DD-4: Flush scope model** = clear provider remote refs/sticky continuity only; keep checkpoint prefix and raw tail semantic assets.
- **DD-5: Provider cleanup ownership** = runtime orchestrates, adapter implements concrete cleanup keys/state.
- **DD-6: Debug observability model** = invalidation errors must emit structured full-state snapshot through existing runtime logger.

## A-trigger Set

- **A1 Identity changed**: any of provider/model/account changed.
- **A2 Provider invalidation**: `previous_response_not_found`, `text part msg_* not found`, or equivalent adapter-level invalidation signals.
- **A3 Restart resume mismatch**: restart path cannot prove local/remote continuation alignment.
- **A4 Checkpoint rebuild untrusted**: rebuild boundary lacks evidence that remote refs are still valid.
- **A5 Explicit reset**: operator/user requests continuation reset.

## Replay Composition

### Rule
`replayPayload = checkpointPrefix + rawTailSteps`

### Example
- Total steps: 1..16
- Checkpoint compacts: 1..10
- Tail (uncompacted): 11..16
- Replay payload: `checkpoint(1..10) + raw(11..16)`

## Debug Log Contract (Full Snapshot)

### Emit conditions
- Any classified continuation invalidation error (including `text part msg_* not found`).

### Sink
- Existing runtime logger.

### Required fields (structured)
- `traceId` / correlation id (if available)
- `providerId`, `modelID`, `accountId`
- trigger evaluation:
  - all trigger booleans A1..A5
  - matched trigger list
  - final `flushRemoteRefs`
- checkpoint/tail state:
  - checkpoint boundary (`checkpointStart`, `checkpointEnd`)
  - tail boundary (`tailStart`, `tailEnd`)
  - counts (`checkpointStepCount`, `tailStepCount`)
- replay summary:
  - composition type (`checkpoint_plus_tail`)
  - serializer input shape summary (no raw secrets/content dump)
- provider invalidation:
  - normalized error code
  - message excerpt
- provider sticky continuity-state summary:
  - keys present / counts / age markers
  - no credential/token leakage
- flush result:
  - cleared key set summary
  - post-flush state summary

### Security/Privacy constraint
- Never log secrets, API keys, raw authorization headers, or full user content payloads.

## Control Flow

1. Build continuation context and evaluate A-triggers.
2. If any trigger matched: execute provider cleanup hook to flush remote refs.
3. Compose replay payload from checkpoint prefix + raw tail steps.
4. Submit next request without stale remote refs.
5. If invalidation error occurs: emit full-state structured debug log snapshot.
6. Accept newly issued remote continuity state for subsequent turns.

## Risks / Trade-offs

- Over-flush may reduce continuity quality -> mitigated by preserving checkpoint + raw tail.
- Under-flush can hard-fail provider continuation -> mitigated by A-trigger fail-fast.
- Provider hidden sticky state may be missed -> mitigated by adapter-owned cleanup hooks and targeted probes.
- Rich logging can leak sensitive data if uncontrolled -> mitigated by strict summary-only logging and redaction constraints.

## Critical Files

- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.ts`
- `packages/opencode/src/provider/sdk/copilot/responses/openai-responses-language-model.ts`
- `packages/opencode/src/plugin/codex.ts`
- `packages/opencode/src/plugin/codex-websocket.ts`
