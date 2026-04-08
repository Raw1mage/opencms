# Proposal

## Why

- Codex WebSocket transport is disabled — it never successfully connected to the chatgpt.com endpoint
- HTTP fallback works but lacks the latency benefits of persistent WS connections (codex-rs reports ~40% faster end-to-end for 20+ tool calls)
- The previous WS attempt silently swallowed errors due to incomplete protocol implementation
- `specs/codex/provider_runtime/` DD-4 explicitly designates WebSocket as an **extension surface under the AI SDK contract** — this plan fulfills that extension

## Original Requirement Wording (Baseline)

- "我們以codex-rs完整重製為最高目標，建立一個針對websocket的reproduction plan"

## Requirement Revision History

- 2026-03-30 (v1): Initial plan — faithful codex-rs reproduction, 8 phases, 46 tasks
- 2026-03-30 (v2): Post-review revision — align with `specs/codex/provider_runtime/`, MVP-first phasing, prewarm shelved, scope narrowed to transport adapter only

## Effective Requirement Description

1. Implement Codex WebSocket as a **transport adapter** beneath the AI SDK request/stream contract (per `specs/codex/provider_runtime/` DD-1, DD-4)
2. Use codex-rs as behavioral reference for protocol correctness, but do NOT replicate its architecture or introduce parallel orchestration
3. MVP-first: prove WS handshake works before adding incremental features
4. Prewarm (`generate=false`) is shelved — not in MVP scope

## Parent Spec

This plan is a sub-plan of **`specs/codex/provider_runtime/`**. All decisions must conform to:
- DD-1: AI SDK Responses path is the authority
- DD-2: Responsibility split = providerOptions first, interceptor second
- DD-4: WebSocket / delta / compaction remain extension surfaces under the same contract

## Scope

### IN

- WS connection to `chatgpt.com/backend-api/codex/responses` (same endpoint as codex-rs)
- WrappedWebsocketErrorEvent parsing (error classification matching codex-rs test suite)
- Synthetic SSE bridge (WS frames → ReadableStream → AI SDK consumes as HTTP SSE)
- Session-scoped connection caching with sticky HTTP fallback
- Account-aware connection lifecycle (close/reconnect on rotation)
- Incremental delta (previous_response_id + input trimming) — Phase 3, after MVP

### OUT

- Prewarm (`generate=false`) — shelved per prior decision
- Realtime API / audio WebSocket
- `/responses/compact` over WS (use HTTP)
- Parallel orchestration stack or custom model runtime
- Modifying AI SDK chunk parsing internals
- Telemetry model/etag tracking (nice-to-have, not MVP)

## Non-Goals

- Replacing AI SDK's stream processing with custom WS-native processing
- Supporting non-Codex providers over WebSocket
- Multi-connection multiplexing

## Constraints

- Must remain a transport adapter: AI SDK sees a `Response` object, unaware of WS
- Bun's WebSocket may not support permessage-deflate — Phase 1 gate investigates this
- chatgpt.com is an internal endpoint; behavior may differ from public API docs
- Must maintain zero-regression: if WS fails at any point, HTTP fallback must work exactly as today

## What Changes

- `packages/opencode/src/plugin/codex.ts` — transport selection in fetch interceptor
- `packages/opencode/src/plugin/codex-websocket.ts` — new file: WS connection, error parsing, stream handler

## Capabilities

### New Capabilities

- Persistent WS connections with connection reuse across turns
- Structured error parsing for Codex WS error types
- Session-scoped WS→HTTP fallback with sticky behavior
- (Phase 3) Incremental delta requests over WS

### Modified Capabilities

- Transport selection: currently always HTTP, will try WS first with HTTP fallback

## Impact

- `packages/opencode/src/plugin/codex.ts` — fetch interceptor transport decision
- `packages/opencode/src/plugin/codex-websocket.ts` — new ~400-600 line file
- Latency: expected improvement on multi-tool-call turns
- Correctness: WS errors now surfaced properly instead of silent empty streams
