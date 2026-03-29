# Proposal

## Why

- Codex WebSocket transport is disabled — it never successfully connected to the chatgpt.com endpoint
- HTTP fallback works but lacks the latency and cost benefits of persistent WS connections
- The current broken WS implementation silently swallowed errors (usage_limit_reached via wrong account), causing infinite empty-response loops
- codex-rs has a production-grade WS implementation (~6,600 lines Rust) that we should faithfully reproduce

## Original Requirement Wording (Baseline)

- "我們以codex-rs完整重製為最高目標，建立一個針對websocket的reproduction plan"

## Requirement Revision History

- 2026-03-30: Initial requirement. User confirmed codex-rs as the authoritative reference, not the official OpenAI public API docs (which target a different endpoint)

## Effective Requirement Description

1. Complete rewrite of Codex WebSocket transport in opencode TypeScript
2. Faithful reproduction of codex-rs behavior: connection management, error parsing, incremental delta, prewarm, retry/fallback
3. Target endpoint is `chatgpt.com/backend-api/codex/responses` (same as codex-rs), NOT `api.openai.com/v1/responses`

## Scope

### IN

- WS connection layer with permessage-deflate, TLS, custom CA support
- WrappedWebsocketErrorEvent parsing with full error classification
- Stream handler with idle timeout, Ping/Pong, Close detection
- Session-scoped transport selection with sticky HTTP fallback
- V2 prewarm (generate=false) for next-turn latency optimization
- Incremental delta (previous_response_id + input trimming)
- Account-aware connection lifecycle (close/reconnect on rotation)
- Retry budget with WS→HTTP fallback on exhaustion

### OUT

- Realtime API / audio WebSocket (different protocol)
- `/responses/compact` over WS (use HTTP)
- Multi-connection multiplexing (spec says sequential only)
- Rate limit header extraction (already handled by existing rotation3d)

## Non-Goals

- Changing the existing HTTP transport path
- Modifying AI SDK internals
- Supporting non-Codex providers over WebSocket

## Constraints

- Bun's WebSocket implementation may not support permessage-deflate natively — needs investigation
- chatgpt.com WS endpoint may have undocumented requirements beyond codex-rs
- Must maintain backward compatibility: if WS fails, HTTP fallback must work exactly as today

## What Changes

- `packages/opencode/src/plugin/codex.ts` — replace disabled WS section (~lines 625-770) with full implementation
- Potentially new file: `packages/opencode/src/plugin/codex-websocket.ts` for WS-specific code

## Capabilities

### New Capabilities

- Persistent WS connections with connection reuse across turns
- Incremental delta requests (send only new items, server caches context)
- V2 prewarm for reduced first-token latency
- Structured error parsing for all Codex WS error types
- Session-scoped WS→HTTP fallback with sticky behavior

### Modified Capabilities

- Transport selection: currently always HTTP, will try WS first
- Error handling: currently swallows WS errors, will surface them properly

## Impact

- `packages/opencode/src/plugin/codex.ts` — major changes to fetch interceptor
- `packages/opencode/src/session/llm.ts` — may need adjustments for WS-specific provider metadata
- Token consumption: expected ~40% reduction in end-to-end latency per OpenAI's claims
- Cost: improved cache hit rate from persistent connection + incremental delta
