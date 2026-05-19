# Observability

## Events

This spec documents upstream (Claude Code CLI) observability signals extracted from the 2.1.144 bundle. No new events are emitted by this documentation work.

### Upstream Events Documented in Datasheet

| Event | Source | Datasheet Section | Description |
|-------|--------|-------------------|-------------|
| SSE `message_start` | API stream | SS7.1 | Initial message with model info and usage |
| SSE `content_block_start` | API stream | SS7.1 | New content block (text/tool_use/thinking) |
| SSE `content_block_delta` | API stream | SS7.1 | Incremental text or input_json delta |
| SSE `content_block_stop` | API stream | SS7.1 | Content block complete |
| SSE `message_delta` | API stream | SS7.1 | End-of-message metadata (stop_reason, usage) |
| SSE `message_stop` | API stream | SS7.1 | Final event |
| SSE `ping` | API stream | SS7.1 | Keep-alive |
| SSE `error` | API stream | SS7.1 | Server error event |
| SSE `compaction_delta` | API stream | SS7.1 | Server-side compaction content (new in 2.1.144) |
| SSE `signature_delta` | API stream | SS7.1 | Response signature (new in 2.1.144) |
| Retry yield message | App retry loop | SS5.4 step 6 | "Rate limited - retrying in Xs" UI message during watchdog 30s chunks |

## Metrics

### Upstream Metrics Documented in Datasheet

| Metric | Source | Datasheet Section | Description |
|--------|--------|-------------------|-------------|
| `anthropic-ratelimit-unified-status` | Response header | SS5.5 | Rate limit verdict: allowed / allowed_warning / rejected |
| `anthropic-ratelimit-unified-reset` | Response header | SS5.5 | Epoch seconds when quota resets |
| `anthropic-ratelimit-unified-*-utilization` | Response header | SS5.5 | Per-window utilization (5h, 7d, overage) |
| `anthropic-ratelimit-unified-*-surpassed-threshold` | Response header | SS5.5 | Warning threshold hit flag |
| `X-Stainless-Retry-Count` | Request header | SS3.3 | SDK retry attempt counter |
| Retry attempt counter | App retry loop | SS5.3 | App-level retry count (0 to DEFAULT_MAX_RETRIES) |
| Consecutive 529 counter | App retry loop | SS5.4 step 5 | Tracks consecutive 529s for fallback model switch |
