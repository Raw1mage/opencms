# Design

## Context

- Current Codex incremental delta behavior is split across two separate concerns: provider continuation for request trimming and runtime streaming transport for output updates.
- RCA proved provider continuation is partially wired, but local runtime still reconstructs full prompt arrays and republishes full accumulated assistant parts on every streamed chunk.
- Existing Web and TUI consumers are optimized around `message.part.updated` carrying a full part with optional `delta`, which preserves correctness but destroys most delta savings.
- The desired steady state is **zero replay, not zero history**: local runtime keeps a full canonical transcript, while provider transport and streaming hot paths move only append-only deltas plus explicit version metadata.

## Goals / Non-Goals

**Goals:**

- Preserve request-side continuation behavior while making its savings measurable.
- Submit only newly added user/tool facts when continuation remains valid.
- Replace full-part streamed transport with an append-only delta-aware contract.
- Keep Web, TUI, and subagent activity views consistent after the contract change.

**Non-Goals:**

- Rebuild the whole message storage model in one iteration.
- Introduce silent compatibility fallback paths that hide contract drift.

## Decisions

- Decision 1: treat request-side continuation and output-side streaming as separate optimization layers, and fix both explicitly rather than assuming one implies the other.
- Decision 2: introduce explicit continuation versioning/invalidation over at least system prompt, tool schema, provider-model identity, transcript base, and upstream state handle.
- Decision 3: make observability part of the implementation slice so the team can prove whether savings are preserved end-to-end.
- Decision 4: shift consumer logic toward append-only delta application on the hot path, while retaining full-part persistence only where durable storage truly requires it.
- Decision 5: align stale-delta protection with the actual hot path (`message.part.updated` with delta-aware semantics or a replacement event), not the legacy standalone `message.part.delta` assumption.
- Decision 6: classify Codex continuation failures by boundary (`first-frame timeout`, `mid-stream stall timeout`, `close-before-completion`, `response.failed`, `previous_response_not_found`) and treat each as an explicit continuation invalidation or rebind decision, never as a silent retry with inherited state.

## Architecture Principles

- Durable transcript is not the same thing as provider transport payload.
- Full local history must remain available for audit, replay, UI correctness, and storage integrity.
- Provider-bound request payloads and streamed hot-path events should carry only append-only deltas plus deterministic version metadata when continuation is valid.
- When continuation is invalid, the runtime must explicitly rebind rather than silently falling back to hidden replay behavior.
- Timeout and close ambiguity are continuation boundaries: once a streamed turn fails before a confirmed completion boundary, the runtime must assume the current continuation pointer may be unusable until it is explicitly rebound.

## Data / State / Control Flow

- User message enters `session/llm.ts`, where Codex continuation may attach `previousResponseId` and provider plugins may trim upstream request input.
- Request assembly must separate provider-bound append-only transport data from durable transcript state; if version hashes mismatch, request assembly must invalidate continuation and rebind explicitly.
- Provider streaming chunks enter `session/processor.ts`, which currently appends text into a growing part and calls `Session.updatePart()`.
- `session/index.ts` currently persists the whole part and publishes `message.part.updated`.
- `server/routes/global.ts` fans the event out over SSE by stringifying the full event.
- Web `global-sdk.tsx` and reducer, plus TUI `context/sync.tsx`, currently reconcile full parts per update; `tool/task.ts` can republish child-session updates into the parent bus.

## Risks / Trade-offs

- Contract migration risk -> Web, TUI, and bridge consumers must move in lockstep to avoid stale or broken streamed output.
- Versioning risk -> if invalidation inputs are incomplete or nondeterministic, the runtime may wrongly reuse or wrongly discard continuation state.
- Persistence trade-off -> durable storage may still need full final parts, but the hot streaming path should not use the same payload shape by default.
- Scope risk -> if local prompt normalization dominates more than output fanout, the plan may need a narrower first slice focused on request construction rather than transport.
- Timeout ambiguity risk -> a request can be accepted upstream and begin streaming, then stall locally before `response.completed`; if the runtime reuses the inherited `previous_response_id` after that boundary, client/server state may drift and subsequent retries may fail with `previous_response_not_found`.

## Continuation Invalidation Boundaries

- `first-frame timeout`: request outcome is ambiguous; disable blind continuation reuse and require explicit rebind policy before fallback.
- `mid-stream stall timeout`: frames have already arrived, so the turn is in-progress but unconfirmed; invalidate append-only continuation state and surface interruption semantics.
- `close before completion`: if the socket closes before a confirmed terminal event, treat the continuation pointer as suspect.
- `response.failed` / WS protocol error: clear both websocket-scoped continuation state and higher-level session continuation state.
- HTTP `400 previous response ... not found`: treat as a hard continuation invalidation, clear cached continuation state, and require either a single explicit full-context rebind or a surfaced fail-fast error.

## Prior Plan Gap Hypothesis

- Earlier Codex planning appears to have treated incremental delta mainly as a provider integration concern (`previousResponseId` / request trim) rather than a full runtime transport contract.
- That framing likely hid the need for explicit version-control / invalidation and also hid the downstream Bus -> SSE -> Web/TUI/subagent amplification path.
- As a result, the previous implementation path could appear "mostly done" once request trim existed, even though the dominant runtime cost still came from replay-shaped local assembly and full-part streaming fanout.

## Critical Files

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/plugin/codex.ts`
- `packages/opencode/src/plugin/codex-websocket.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/server/routes/global.ts`
- `packages/app/src/context/global-sdk.tsx`
- `packages/app/src/context/global-sync/event-reducer.ts`
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `packages/opencode/src/tool/task.ts`
