# Proposal: codex-update

## Why

- Codex submodule was just bumped from `5cc5f12ef` to `f7e8ff8e5` (218 commits), introducing wire-format and protocol changes upstream that our `packages/opencode-codex-provider/` has not yet absorbed.
- Without this work, the provider silently ignores new event frames, may emit stale headers, and may fall behind on cache-key / service-tier propagation — symptoms today are subtle (missed analytics, missing cache hits) but compound as upstream evolves.
- Codex provider is one of two primary providers; keeping it within ~1 month of upstream is the established cadence (see prior `codex-refactor` history).

## Original Requirement Wording (Baseline)

- "開一個codex update plan, 分析新版差異，然後實作在我們的codex provider上使版本功能同步"
- Prior turn triage focus list (provided as starting points, not exhaustive):
  1. Add `response.processed` WS event in `types.ts`
  2. `thread_id` vs `session_id` semantic split in `headers.ts`
  3. WS send-side idle timeout in `transport-ws.ts`
  4. `service_tier` + `prompt_cache_key` propagation in compaction
- User-provided caveat: ignore `codex-rs/app-server*/` (codex CLI's internal RPC, not surface we mirror); only `codex-rs/core/src/client.rs`, `responses_*`, `chatgpt/`, `login/` count.

## Requirement Revision History

- 2026-05-07: initial draft created via plan-init.ts
- 2026-05-07: scoped to upstream range `5cc5f12ef..f7e8ff8e5` (codex submodule bump in commit `dbd8f7215`)

## Effective Requirement Description

1. Produce a complete, evidence-backed diff audit of the codex submodule range scoped to the surface area we mirror (the four codex-rs paths above).
2. Land code changes in `packages/opencode-codex-provider/` to bring the provider to feature parity with upstream — additive features adopted, breaking changes accommodated, deprecated/removed surfaces cleaned up.
3. Verify with provider unit tests + a live smoke run against the codex backend before promoting to `verified`.

## Scope

### IN
- `packages/opencode-codex-provider/src/` — all 14 source files are candidates; concrete touch list emerges in design phase
- Codex submodule range `5cc5f12ef..f7e8ff8e5` audit, narrowed to:
  - `codex-rs/core/src/client.rs`
  - `codex-rs/core/src/responses_*` (Responses API client + types)
  - `codex-rs/chatgpt/` (ChatGPT-backend specifics)
  - `codex-rs/login/` (OAuth flow)
  - `codex-rs/protocol/` (wire schemas — only the parts our provider consumes)
- Provider unit tests under `packages/opencode-codex-provider/src/*.test.ts`
- A live smoke run hitting the real ChatGPT backend with a refreshed account

### OUT
- `codex-rs/app-server*/` — codex CLI's internal JSON-RPC, not what we mirror
- `codex-rs/tui/` — TUI-only changes
- `codex-rs/mcp*/`, `codex-rs/plugin/`, `codex-rs/skill*/` — unless they touch the Responses-API request/response shape we use
- New codex *features* whose backend support is gated behind ChatGPT enterprise tiers we don't have access to (defer with an explicit out-of-scope note in design.md)
- Refactor of provider architecture beyond what's needed for parity (out of scope; would be a separate `extend` plan)

## Non-Goals

- Not bumping codex submodule again during this plan — pinned at `f7e8ff8e5`
- Not redesigning provider auth flow — only adopting upstream's OAuth changes if any
- Not introducing new abstractions to "future-proof" — additive changes only

## Constraints

- AGENTS.md rule 1: no silent fallback. If a new codex feature is detected in the diff but cannot be tested against the live backend, surface it in design.md as a known gap, do not silently skip.
- Beta-workflow applies: implementation lands on a beta branch (`beta/codex-update` or similar), fetch-back into `~/projects/opencode` `test/codex-update-*` then merged to `main`.
- Provider unit tests must continue to pass on every commit; Bun test runner is the gate.
- Account isolation per memory: don't run live smoke from main `~/.config/opencode/`; use OPENCODE_DATA_HOME-isolated test account or codex-empty-turn-recovery's existing test fixtures.
- No drift in codex submodule pointer during this plan — it stays at `f7e8ff8e5`. If a follow-up bump is needed, it opens a new revise.

## What Changes

- `packages/opencode-codex-provider/src/types.ts` — likely add new event type variants
- `packages/opencode-codex-provider/src/headers.ts` — likely thread_id / session_id semantics adjustment
- `packages/opencode-codex-provider/src/transport-ws.ts` — likely send-side idle timeout
- `packages/opencode-codex-provider/src/protocol.ts` — possible compaction request body fields
- Other files: TBD pending design-phase audit
- New tests covering each behavioral delta
- Submodule pointer: NOT changed (stays at `f7e8ff8e5` from commit `dbd8f7215`)

## Capabilities

### New Capabilities
- `response.processed` event handling — provider observes post-completion processing signal (used for analytics / cache reconciliation upstream)
- Send-side WS idle timeout — provider drops a stalled send that exceeds the configured idle bound, instead of holding the connection open

### Modified Capabilities
- Header emission: `thread_id` becomes a first-class field distinct from `session_id` (current behavior treats them as one)
- Compaction requests: optional `service_tier` + `prompt_cache_key` propagation for cache-hit alignment
- Possibly more — design.md will enumerate after the full surface-area audit

## Impact

- **Provider package** (`packages/opencode-codex-provider/`): direct edits + new tests
- **Runtime telemetry**: more events flowing through the provider's event log; `empty-turn-classifier` may need a quick review to confirm `response.processed` doesn't trip its empty-turn heuristic
- **Account state**: no schema change expected; but if `thread_id` becomes persisted, account record may grow a field — flag during design
- **Other providers** (Anthropic, Gemini): no impact
- **Beta workflow**: standard beta-branch + fetch-back cadence
- **Docs**: provider README (if any) gets a one-line note on the new event support

## Open Questions (resolve in design phase)

1. Is `response.processed` consumed by any opencode core logic (session.ts, bus, telemetry), or do we just need to not crash on it? (Default: not crash + log; revise if core wants it.)
2. Does the ChatGPT backend actually require `thread_id` in headers today, or is it forward-compat for codex CLI internals only? Need wire capture from a live session.
3. WS send-side idle timeout — does upstream make it configurable, or hardcoded? Match upstream's choice for parity.
4. Are there breaking changes in the OAuth flow (codex-rs/login/) we missed? Full diff scan needed.
5. How many of the 218 commits actually touch our four surface paths? Audit produces the count; if >40 commits, design phase splits into sub-phases.
