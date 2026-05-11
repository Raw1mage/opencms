---
date: 2026-05-11
summary: "Chapter 07 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D7-1 + D7-2 datasheets"
---

# Chapter 07 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D7-1 + D7-2 datasheets

## Audit result: PASS

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (unchanged).
- **Claims**: 12 (C1–C12).
- **Anchors**: 12.
- **TEST/TYPE diversity**: **2 TYPE** (C3 ResponseEvent enum, C10 ResponseCreateWsRequest struct) + **1 TEST** (C12 spawn_response_stream_emits_header_events). Plus 1 const-block anchor (C6) and 8 fn-body anchors.
- **Open questions**: 0.

## Datasheets delivered

- **D7-1**: SSE event stream (server → client). 13 ResponseEvent variants tabulated with trigger, required, source, per-turn/streaming, notes. Termination contracts (Completed / stream-end / idle / error) documented. Sanitized example SSE wire bytes.
- **D7-2**: HTTP request envelope (client → server). Method/Path/Accept/Body/Compression slots. Critical: previous_response_id is NOT in HTTP body — exclusive to WS path (Ch08).

## Cross-diagram traceability (per miatdiagram §4.7)

Walked:
- endpoint/responses.rs::stream → A7.1 → D7-2 ✓
- endpoint/session.rs::stream_with → A7.2 ✓
- Transport.stream → A7.3 ✓
- sse/responses.rs::process_sse → A7.4/A7.5/A7.6 → D7-1 ✓
- common.rs::ResponseEvent → D7-1 variant table ✓
- common.rs::ResponseCreateWsRequest (C10) → forward link to Ch08 ✓
- TEST C12 → header→event projection contract ✓

## Audit table

| Cn | Anchor | Kind | Verified |
|---|---|---|---|
| C1 | endpoint/responses.rs:102 | fn const path | ✓ path="responses" + POST hard-coded |
| C2 | endpoint/responses.rs:137 | configure closure | ✓ Accept: text/event-stream |
| C3 | common.rs:71 | enum | ✓ 13 variants |
| C4 | sse/responses.rs:433 | fn | ✓ process_sse drives the loop |
| C5 | sse/responses.rs:445 | tokio::timeout | ✓ idle timeout wraps stream.next() |
| C6 | model-provider-info/lib.rs:25 | const block | ✓ 300s idle / 5 retries / 100 cap |
| C7 | endpoint/session.rs:120 | fn | ✓ retry + auth + stream |
| C8 | provider.rs:25 | impl | ✓ RetryOn { 429, 5xx, transport } |
| C9 | sse/responses.rs:505 | conditional return | ✓ Completed = terminal |
| C10 | common.rs:215 | struct | ✓ WS-only previous_response_id field |
| C11 | sse/responses.rs:482 | conditional emit | ✓ ServerModel dedup |
| C12 | sse/responses.rs:1073 | TEST | ✓ header → ResponseEvent projection |

## Key OpenCode drift findings

1. **OpenCode defaults to WS, not HTTP SSE** for codex (HTTP SSE is fallback only). Most observed codex traffic on OpenCode rides Ch08 mechanics.
2. **No upstream-style RetryPolicy** per HTTP request — OpenCode delegates to daemon's rate-limit judge.
3. **`response.completed` semantics aligned** — both implementations treat as strictly terminal.
4. **Idle timeout differs** — OpenCode's WS path uses keepalive instead of 300s per-event idle.

## Cumulative spec progress (7/12 chapters audited)

- 84 claims / 84 anchors total
- 7 TEST + 33 TYPE
- 9 datasheets (D2-1, D2-2, D4-1, D4-2, D5-1, D6-1, D6-2, D7-1, D7-2)
- 0 open questions
- All on SHA 76845d716b

## Next

Chapter 08 — WebSocket Transport. The most operationally relevant chapter for OpenCode because **OpenCode's primary codex transport is WS**. Covers handshake headers, first-frame body shape (uses ResponseCreateWsRequest with previous_response_id), turn-state sticky routing, reconnect logic. Will be substantial — the WS path has more state machinery than HTTP SSE.
