# Implementation Spec

## Goal

- Make Codex incremental delta effective end-to-end by preserving request-side continuation savings and eliminating full-part/full-event amplification across session, SSE, and UI consumers.
- Achieve **zero replay, not zero history**: once a valid continuation contract exists, each round should submit only newly added facts plus continuation/version metadata, while local durable history remains complete.

## Scope

### IN

- Codex request continuation path in `packages/opencode/src/session/llm.ts`, `packages/opencode/src/plugin/codex.ts`, and `packages/opencode/src/plugin/codex-websocket.ts`
- Continuation invalidation/version-control rules for system prompt, tool schema, provider-model identity, transcript surgery, and upstream state expiry
- Timeout / close / `previous_response_not_found` continuation failure handling across websocket-scoped state and session-level Codex response state
- Session part update contract in `packages/opencode/src/session/processor.ts`, `packages/opencode/src/session/index.ts`, and `packages/opencode/src/session/message-v2.ts`
- SSE fanout path in `packages/opencode/src/server/routes/global.ts`
- Web delta consumption path in `packages/app/src/context/global-sdk.tsx` and `packages/app/src/context/global-sync/event-reducer.ts`
- TUI delta consumption path in `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- Subagent bridge amplification path in `packages/opencode/src/tool/task.ts`
- Validation and observability for delta length vs full payload length

### OUT

- Replacing the upstream Codex continuation protocol itself
- Broad provider-agnostic streaming refactors outside the traced hot path
- Rotation3D / fallback policy changes unrelated to incremental delta
- Unrelated prompt compaction or quota fixes

## Assumptions

- Codex `previousResponseId` / `previous_response_id` continuation semantics remain valid and should be preserved.
- Existing consumers can be upgraded to a delta-aware event contract without requiring a silent fallback path.
- The desired fix is fail-fast and observable; no hidden compatibility fallback should be introduced.
- The canonical local transcript remains durable even when the provider transport becomes append-only.

## Stop Gates

- Stop if upstream Codex protocol behavior differs from the traced request-trim model and requires a new provider contract.
- Stop if a delta-only or dual-event transport would break existing app/TUI/subagent consumers in a way not represented in this plan.
- Stop if measured instrumentation shows request-side local prompt construction, not output fanout, is the dominant cost; re-plan scope before implementation.
- Stop if required invalidation/version metadata cannot be derived deterministically for system prompt, tools, or provider-model identity.
- Stop if timeout/close semantics cannot distinguish `first-frame timeout` from `mid-stream stall timeout`, because continuation invalidation and retry policy then need an explicit product decision before implementation.
- Stop for approval before widening the change from Codex-specific hot paths to all providers.

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
- `docs/events/event_20260330_codex_incremental_delta_rca.md`

## Structured Execution Phases

- Phase 1: instrument the request and output hot paths to prove where delta is preserved and where full payload amplification dominates.
- Phase 2: define continuation versioning/invalidation rules so append-only request submission is explicit, fail-fast, and observable, including timeout/close ambiguity and `previous_response_not_found` recovery boundaries.
- Phase 3: rewrite the runtime event contract so streamed assistant updates can travel as true append-only delta data instead of repeated full parts.
- Phase 4: update web, TUI, and subagent bridge consumers to apply the new contract, then validate reduced payload sizes and reconcile cost.

## Validation

- Add instrumentation that records `delta.length`, `part.text.length`, and `JSON.stringify(event).length` by part id.
- Verify request continuation still trims upstream Codex input while local prompt construction is either reduced or explicitly measured.
- Verify append-only request submission is invalidated when system prompt hash, tool schema hash, provider/model identity, or upstream conversation state changes.
- Verify websocket `first-frame timeout`, `mid-stream stall timeout`, `close before completion`, and HTTP `400 previous response not found` all clear or invalidate continuation state consistently across websocket state and session-level Codex state.
- Verify Web and TUI render correct assistant output without stale, duplicated, or missing chunks.
- Verify subagent activity still renders correctly after bridge-path changes.
- Run targeted tests and/or focused verification for the touched session/app/TUI files, plus an end-to-end streamed response sanity check.

## Handoff

- Build agent must read this spec first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md / handoff.md before coding.
- Build agent must materialize runtime todo from tasks.md and preserve planner task naming.
- Build agent must prefer delegation-first execution when the task slice can be safely handed off.
