# Design

## Context

- `specs/codex_provider_runtime/` establishes AI SDK Responses path as authority (DD-1)
- DD-4 explicitly designates WebSocket as an extension surface under the same contract
- codex-rs has a production WS implementation (~6,600 lines Rust) that serves as behavioral reference
- The WS endpoint is `chatgpt.com/backend-api/codex/responses` (internal, not `api.openai.com`)
- Previous WS attempt failed: no successful handshake, silent error swallowing, wrong account auth

## Goals / Non-Goals

**Goals:**

- Transport adapter: AI SDK sees a `Response` object, unaware of underlying WS
- Protocol correctness: error classification matching codex-rs test suite
- Session-scoped connection lifecycle with clean HTTP fallback
- MVP-first: prove handshake works before adding features

**Non-Goals:**

- Faithful architecture reproduction of codex-rs (only behavior, not structure)
- Parallel orchestration stack
- Prewarm (shelved)
- Performance parity with native Rust

## Decisions

- DD-WS-1: **Transport adapter pattern** — WS handler produces a synthetic `Response(ReadableStream)` that AI SDK consumes as if HTTP SSE. This is the same pattern used by the previous (broken) attempt, and it avoids modifying AI SDK internals. Conforms to `specs/codex_provider_runtime/` DD-1.
- DD-WS-2: **Single new file** — Extract WS code into `codex-websocket.ts`. The fetch interceptor in codex.ts delegates WS transport decisions to this module. Conforms to DD-2 (interceptor layer responsibility).
- DD-WS-3: **codex-rs as behavioral reference, not architectural blueprint** — We reproduce the protocol behavior (error event format, connection lifecycle, incremental delta) but use TypeScript idioms, not Rust patterns. No tokio, no MPSC channels, no Arc<Mutex>.
- DD-WS-4: **MVP-first phasing** — Phase 1 is the smallest possible proof: connect + send + receive + SSE bridge. No caching, no delta, no retry. If Phase 1 fails, we stop and keep HTTP.
- DD-WS-5: **Sticky fallback** — Once HTTP fallback activates for a session, it stays HTTP for the session's lifetime (matching codex-rs `disable_websockets` behavior). New sessions still try WS.
- DD-WS-6: **Error-first frame parsing** — Check WrappedWebsocketErrorEvent BEFORE parsing as ResponsesStreamEvent (matching codex-rs line 594-598). This is the root cause of the previous silent-error bug.
- DD-WS-7: **Deflate optional** — If Bun doesn't support permessage-deflate, proceed without it. Uncompressed WS still works, just higher bandwidth.

## Data / State / Control Flow

### Phase 1 flow (MVP)

```
AI SDK calls fetch(codex_url, request_body)
  → codex.ts interceptor: try WS
    → codex-websocket.ts: connectWs(url, headers)
      → WebSocket handshake to wss://chatgpt.com/backend-api/codex/responses
      → If fails: return null → interceptor falls through to HTTP
    → sendWsRequest(ws, body): serialize response.create, send Text frame
    → receiveLoop(ws): collect frames until response.completed
      → Each frame: encode as "data: {json}\n\n"
    → Return new Response(readableStream, {headers: {"content-type": "text/event-stream"}})
  → AI SDK parses SSE as usual
```

### Phase 2 additions

```
Error handling:
  Each frame → parseWrappedWebsocketErrorEvent() first
    → If error: throw typed error → rotation/retry handles it
    → If not error: parse as ResponsesStreamEvent

Connection caching:
  Map<sessionId, {ws, accountId, status}>
    → On request: check cache → reuse if open + same account
    → On account mismatch: close + reconnect
    → On error after retries: forceHttpFallback() → sticky for session
```

## Risks / Trade-offs

- **Bun WS TLS to chatgpt.com** → Phase 1 gate validates this. If fails: evaluate `ws` npm package.
- **Undocumented endpoint requirements** → codex-rs is our best reference, but chatgpt.com may have changed since the codex-rs snapshot. Mitigation: stderr DIAG traces for debugging.
- **Synthetic SSE format** → AI SDK's EventSourceParserStream expects specific format. Previous attempt proved the format works; Phase 1 re-validates.
- **Connection state leaks** → WS connections must be cleaned up on session end. Mitigation: session-scoped Map with explicit close on removal.

## Critical Files

- `packages/opencode/src/plugin/codex-websocket.ts` — new file
- `packages/opencode/src/plugin/codex.ts` — fetch interceptor transport selection
- `specs/codex_provider_runtime/design.md` — architectural constraints (DD-1, DD-2, DD-4)
- `refs/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs` — protocol reference
- `refs/codex/codex-rs/core/src/client.rs` — transport selection / fallback reference
