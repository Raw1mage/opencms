# Invariants: codex-update

Cross-cut guarantees that any future change to `packages/opencode-codex-provider/` MUST preserve. Bug fixes / hotfixes / revisions on this provider must include this section verbatim per plan-builder §17.

## INV-1: session_id and thread_id always paired

If `session_id` HTTP header is emitted, `thread_id` HTTP header is also emitted. They may carry equal values (single-thread default) or distinct values, but never one without the other.

- Enforcement point: `headers.ts:buildHeaders()`
- Rationale: upstream codex's `build_session_headers(Some, Some)` always emits both; emitting only one breaks server-side correlation logic.

## INV-2: x-client-request-id equals thread_id

The `x-client-request-id` HTTP header value always equals the `thread_id` HTTP header value (when both are emitted).

- Enforcement point: `headers.ts:buildHeaders()`
- Rationale: upstream codex source: `codex-rs/core/src/client.rs:871` derives both from the same `thread_id` variable. Drift between them would break server-side request correlation.

## INV-3: prompt_cache_key equals thread_id (unless explicitly overridden)

Unless the caller passes `providerOptions.promptCacheKey`, the `prompt_cache_key` body field equals the thread_id header value.

- Enforcement point: `provider.ts` request body construction
- Rationale: upstream codex (`codex-rs/core/src/client.rs:713`) sets `prompt_cache_key = self.state.thread_id.to_string()`. Server-side prompt cache keying assumes this alignment; divergence reduces cache hit rate.

## INV-4: Single source of WS_IDLE_TIMEOUT_MS for both directions

Receive-side and send-side WS idle timeouts use the *same* constant, `WS_IDLE_TIMEOUT_MS`.

- Enforcement point: `protocol.ts` constant, used in both timer call sites in `transport-ws.ts`
- Rationale: upstream codex uses one `idle_timeout` for both `ws_stream.send(...)` and the recv loop. Asymmetric bounds would mean a slow send appears as a recv stall (or vice versa), confusing the classifier.

## INV-5: Empty-turn classifier categorizes new errors as transient

Any new `wsErrorReason` value that signals a connection-level failure (not a content-level one) is categorized as `transient` with `retry` recovery — not `permanent` or `degraded`.

- Enforcement point: `empty-turn-classifier.ts` enum/switch
- Rationale: connection-level failures are by definition retryable; misclassifying as permanent would burn account quota on rotation thrash without fixing the underlying transient.

## INV-6: No silent fallback on missing required fields

Per AGENTS.md rule 1 and per project memory `feedback_no_silent_fallback`: if a required option is missing (e.g. `accessToken`), the function throws or returns an explicit error — never silently picks a default.

- Enforcement point: `headers.ts`, `provider.ts`
- Rationale: silent fallback masks misconfiguration; explicit errors surface them. Note: `threadId` defaulting to `sessionId` is NOT silent fallback — it's a documented semantic (DD-1) that preserves the single-thread case.

## INV-7: Provider tests stay deterministic and self-contained

All tests under `packages/opencode-codex-provider/src/*.test.ts` run without network, without filesystem state outside `os.tmpdir()`, and without depending on a live codex account. Live-smoke is a separate, manual procedure.

- Enforcement point: test files; `bun test` invocation
- Rationale: CI must run on every commit; flaky live-network tests block the branch.
