# Design: codex-update

## Context

Upstream codex submodule was bumped 218 commits (`5cc5f12ef..f7e8ff8e5`) in commit `dbd8f7215`. This plan brings `packages/opencode-codex-provider/` to feature parity with the subset of upstream changes that touch surfaces we mirror (Responses API client, OAuth, ChatGPT auth, wire protocol). App-server / TUI / MCP / plugin / skills internals are excluded per scope (proposal §IN/OUT).

## Goals / Non-Goals

### Goals
- Detect every wire-format and behavioral change in our mirrored surfaces during the bump range
- Land minimal, additive changes in the provider — preserve old behavior on failure paths, adopt new fields on success paths
- Keep all existing provider tests green; add tests for each behavioral delta
- Document upstream features we deliberately don't adopt (with reason)

### Non-Goals
- No provider architecture refactor
- No second submodule bump during this plan (pinned at `f7e8ff8e5`)
- No backend-only behaviors (e.g. server-initiated compact internals) — those don't have a client-side surface

## Audit Result — Upstream Changes by Surface

Audit method: `git -C refs/codex log --oneline 5cc5f12ef..f7e8ff8e5 -- <path>` per surface, then `git show <sha>` for each candidate commit. Only commits whose diffs touch the public wire surface or client-observable behavior are listed below.

### A. `codex-rs/core/src/client.rs` — Responses request builder

| # | Commit | Effect on wire / behavior | Action for our provider |
|---|---|---|---|
| A1 | `a98623511b` (#20437) | `session_id` and `thread_id` become **distinct concepts**. Headers: emit both via `build_session_headers(session_id, thread_id)`. `x-client-request-id` now sourced from `thread_id` (was `conversation_id`). `prompt_cache_key` now sourced from `thread_id` (was `conversation_id`). | **Adopt.** Update [headers.ts](packages/opencode-codex-provider/src/headers.ts) to emit `thread_id` header alongside `session_id`; switch `x-client-request-id` source to thread_id. See DD-1, DD-2. |
| A2 | `2070d5bfd3` (#21284) | New **outbound** WS request `{type: "response.processed", response_id: <id>}` sent client→server after a response completes and the client successfully processes the turn. Gated by a session-owned server feature flag. | **Defer.** Server gates this behind a flag we cannot detect from the public API. Implementation cost is low but value is zero unless the flag flips on. Out of scope until we observe the flag activate. See DD-5. |
| A3 | `be1d3cff93` (#20971) | `service_tier` field type in upstream Rust changed from enum `ServiceTier` to `String`. Wire values unchanged (`"priority"`, `"flex"`). | **No-op.** [types.ts:19](packages/opencode-codex-provider/src/types.ts#L19) already declares `service_tier?: string`. |
| A4 | `5d6f23a27b` (#21249) | Upstream's `/responses/compact` endpoint now propagates `prompt_cache_key` + `service_tier` from the parent request. | **No-op.** Our provider does not call `/responses/compact`. We use server-side compact via `context_management: [{type: "compaction", compact_threshold}]` ([provider.ts:80](packages/opencode-codex-provider/src/provider.ts#L80)) in the normal request, and the codex backend internally honors prompt_cache_key alignment. See DD-4. |
| A5 | `35aaa5d9fc` (#20751) | WS `ws_stream.send(...)` is now wrapped in `tokio::time::timeout(idle_timeout, …)` to bound the send side, not just the receive side. | **Adopt.** [transport-ws.ts:571](packages/opencode-codex-provider/src/transport-ws.ts#L571) sends fire-and-forget. Add a send-side timeout. See DD-3. |
| A6 | `8126af3879` (#21026) | Codex internally records `last_model_request_id` and `last_model_response_id` for feedback report breadcrumbs. | **No-op.** Internal to codex's feedback flow; we don't surface feedback reports. |
| A7 | `e3451ce6be` (#20989) | Upstream extracted shared `ResponsesApiRequest` builder so normal + compact requests share construction. | **No-op.** Pure refactor. No wire change. |
| A8 | `d927f61208` (#20773) | Feature-flagged `remote_compaction_v2` client path that runs compaction through the regular Responses stream and installs a `context_compaction` item. | **No-op.** Feature-flagged off by default; backend behavior; no client-side change required from us. Observe via `[CODEX-WS]` logs if the new compaction item type appears. |

### B. `codex-rs/chatgpt/` — ChatGPT-backend specifics
- `7b3de63041` (#20348): plugin code moved out of core. **Does not touch our surface.** No-op.

### C. `codex-rs/login/` — OAuth flow
- `0d418f478d` (#21059): renames internal `login_with_agent_identity` → `login_with_access_token`. The `CODEX_ACCESS_TOKEN` env-var path is for non-OAuth, agent-identity-pipe-fed scenarios (not our OAuth+ChatGPT-Account-Id flow). **No-op.**
- `6014b6679f` (#20504): test-only flake fix. **No-op.**

### D. `codex-rs/protocol/` — wire schemas
- Aside from the `session_id` / `thread_id` / `service_tier-string` changes already covered above, the rest of the diff (skills, MCP elicitations, hook trust metadata, turn items refactor, list ops removal) is internal to codex CLI / app-server protocol and **not exposed via the ChatGPT Responses API we consume**. No-op.

## Decisions

- **DD-1** Provider gains a distinct `threadId` field on request input, semantically separate from `sessionId`. Default when caller omits: `threadId = sessionId` (forward-compat: same UUID, harmless for single-thread scenarios). Reason: opencode does not have codex's sub-agent threading model; we only care about staying wire-compatible. (2026-05-07)
- **DD-2** The `prompt_cache_key` source switches from `sessionId` to `threadId` (which == sessionId by default per DD-1, so no behavioral change for current callers, but semantically aligned with upstream). The custom-override path (`promptCacheKey` option in [provider.ts:64-67](packages/opencode-codex-provider/src/provider.ts#L64-L67)) is preserved. (2026-05-07)
- **DD-3** Send-side WS idle timeout: wrap `ws.send(...)` with a Promise that settles via `ws.send(payload, callback)` and a `setTimeout` race at the existing `WS_IDLE_TIMEOUT_MS` (30s). On timeout, abort with reason `ws_send_timeout`, drop the connection, and surface to the empty-turn classifier as a transient failure. Constant remains shared with receive-side. (2026-05-07)
- **DD-4** `/responses/compact` direct invocation is **out of scope**. Reason: provider relies on server-side compact via `context_management` in the normal request body. Codex backend (`/responses` endpoint) internally calls compact when threshold is met and applies #21249's cache_key/service_tier propagation transparently. If we ever start client-initiated compact, revise back into this plan. (2026-05-07)
- **DD-5** `response.processed` outbound WS request is **deferred**, not implemented. Reason: gated by a server-owned session feature flag (#21284 commit message); we cannot observe activation from the public API. Tracking note: if `[CODEX-WS]` logs ever show the server *expecting* a response.processed ack (e.g. via a follow-up frame requesting one), open a revise to add it. Implementation cost when needed: ~10 LOC in [transport-ws.ts](packages/opencode-codex-provider/src/transport-ws.ts). (2026-05-07)
- **DD-6** No new headers or body fields for `x-codex-window-id`, `x-codex-parent-thread-id`, `x-openai-subagent`, `x-codex-turn-state` — those are unchanged upstream and our provider already mirrors them. Verified by `git -C refs/codex grep` in audit phase. (2026-05-07)

## Risks / Trade-offs

- **R1 — thread_id / session_id confusion in the field.** If a caller stores stale references and passes the wrong UUID into the wrong slot, header values will be inconsistent. *Mitigation:* DD-1 default `threadId = sessionId` covers all current callers without breaking anything; add an integration test that asserts both headers present and equal-by-default.
- **R2 — Send-side timeout false positives.** A legitimately slow network could trip `ws_send_timeout`. *Mitigation:* 30s is a long bound (matches receive-side); if false positives observed, raise to 60s only for send-side. Telemetry via existing `wsErrorReason`.
- **R3 — Smoke test depends on a live ChatGPT-backed codex account.** Without one, only unit tests can validate. *Mitigation:* the `codex-empty-turn-recovery` plan already established a live-test protocol; reuse it.
- **R4 — Submodule pointer drift if main branch advances during this plan.** *Mitigation:* spec pins `f7e8ff8e5`. If user bumps codex again, this plan completes against `f7e8ff8e5` first; a follow-up `extend` reopens for the new range.

## Critical Files

| File | Change | Test |
|---|---|---|
| [packages/opencode-codex-provider/src/headers.ts](packages/opencode-codex-provider/src/headers.ts) | Add `threadId` option; emit `thread_id` header; switch `x-client-request-id` source to `threadId`; default `threadId = sessionId` when omitted (DD-1, A1) | [headers.test.ts](packages/opencode-codex-provider/src/headers.test.ts) — add cases for both-emitted, default-equality, custom-thread-id |
| [packages/opencode-codex-provider/src/provider.ts](packages/opencode-codex-provider/src/provider.ts) | Add `threadId` to `BuildHeadersOptions` plumbing; promptCacheKey now sources `threadId` (DD-2); pass through to headers builder | [provider.test.ts](packages/opencode-codex-provider/src/provider.test.ts) — extend existing prompt_cache_key cases |
| [packages/opencode-codex-provider/src/transport-ws.ts](packages/opencode-codex-provider/src/transport-ws.ts) | Wrap `ws.send` with promise + timeout race; on timeout, abort with `ws_send_timeout` reason; thread the new `wsErrorReason` value (DD-3) | [transport-ws.test.ts](packages/opencode-codex-provider/src/transport-ws.test.ts) — add a stalled-send mock case |
| [packages/opencode-codex-provider/src/types.ts](packages/opencode-codex-provider/src/types.ts) | Add `threadId?: string` to relevant request input shape (single field; not a union expansion) | covered by callers' tests |
| [packages/opencode-codex-provider/src/empty-turn-classifier.ts](packages/opencode-codex-provider/src/empty-turn-classifier.ts) | Recognize `ws_send_timeout` as a transient failure category (alongside existing `first_frame_timeout` / `mid_stream_stall`) | [empty-turn-classifier.test.ts](packages/opencode-codex-provider/src/empty-turn-classifier.test.ts) — new case |

## Out-of-Scope Upstream Features (documented for future revives)

- `response.processed` outbound ack (DD-5): defer
- `remote_compaction_v2` client path (A8): observe; backend-driven
- Direct `/responses/compact` calls (A4 / DD-4): not used; revise if business need emerges
- Codex CLI internal app-server, MCP elicitations, hook trust, skills watcher, turn items refactor: out of mirror scope per proposal

## Validation Plan

1. **Unit tests**: run `bun test packages/opencode-codex-provider/` — must be green
2. **Live smoke**: with an isolated XDG (per memory: beta-XDG-isolation), start opencode and run a one-shot codex turn; verify in `[CODEX-WS] REQ` log lines that both `session_id` and `thread_id` headers are emitted with equal default values
3. **Stalled-send simulation**: mock test forces `ws.send` callback to never fire; verify `ws_send_timeout` triggers within 30s and the empty-turn classifier records it
4. **No regression**: existing `codex-empty-turn-recovery` provider tests must remain green
