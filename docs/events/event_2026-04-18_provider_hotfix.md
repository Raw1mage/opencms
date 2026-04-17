# 2026-04-18 — Provider Hotfix (Upstream Sync + disabled_providers Bypass)

## Context

Two unrelated pathologies surfaced while investigating a session that suddenly stopped working:

1. **openai provider silently unusable** — operator had `openai` listed in `disabled_providers` (from a legacy 109-entry denylist); explicit `getModel("openai", …)` failed with `ModelNotFoundError` because the post-processing loop deleted `providers["openai"]` even though the operator had a valid OAuth account and was deliberately selecting the provider. Mirrors the manual-pin-bypass issue fixed on 2026-04-17 (`plans/manual-pin-bypass-preflight/`).
2. **Upstream drift** — `refs/claude-code` (31 commits since 2026-03-21) and `refs/codex` (774 commits) had moved on. Filtering noise left three concrete gaps: codex logout did not revoke OAuth tokens upstream; codex Responses API requests missed the 2026-04 context-window lineage headers; Anthropic's `xhigh` effort variant was not wired for Opus 4.7+.

Plan package: `plans/provider-hotfix/` (10/10 artifacts validated).

## Phase 1 — Codex logout OAuth revoke

Upstream ref: codex-rs `22f7ef1cb7` (2026) — logout must notify `https://auth.openai.com/oauth/revoke` with `token_type_hint=refresh_token` before clearing local state.

- `packages/opencode-codex-provider/src/auth.ts` — new `revokeRefreshToken()` helper posting to the revoke endpoint. Non-2xx and network failures throw (fail-closed); error message truncates any upstream response body to 200 chars so tokens echoed by the edge cannot leak into our logs.
- `packages/opencode-codex-provider/src/index.ts` — export `revokeRefreshToken`.
- `packages/opencode/src/plugin/codex-auth.ts` — new `logoutCodex(refreshToken, context)` wrapper that logs on no-op / success / failure branches and rethrows.
- `packages/opencode/src/account/index.ts::remove` — pre-deletion hook: when `provider === "codex"` and the entry is a subscription account, call `logoutCodex` BEFORE deleting the local entry. If the revoke throws, local credentials stay in place and the operator sees the error.

Tests: 5 passing (`packages/opencode-codex-provider/src/auth.test.ts`) — URL / body shape, 2xx resolve, non-2xx throw, network error throw, log truncation.

## Phase 2 — Context-window lineage headers

Upstream ref: codex-rs `9e19004bc2` — `/responses` requests now carry `x-codex-window-id`, `x-codex-parent-thread-id`, `x-openai-subagent` for caching + abuse-detection.

Pre-existing infrastructure: `WindowState { conversationId, generation }` already threaded through `CodexLanguageModel` and emitted as `x-codex-window-id` at `headers.ts:44`. Needed: the two new headers plus upstream request-header plumbing.

- `packages/opencode/src/session/llm.ts` — resolve parent session id alongside `subagentSession`; emit three extra headers when the target provider is `@opencode-ai/codex-provider`:
  - `x-opencode-parent-session` — `session.parentID ?? ""`
  - `x-opencode-subagent` — `agent.name` when subagent, `""` otherwise
  - existing `session_id` + `x-opencode-session` unchanged
- `packages/opencode-codex-provider/src/provider.ts` — read the new opencode-side headers; empty-string sentinel means "top-level session, skip emission".
- `packages/opencode-codex-provider/src/headers.ts` — `BuildHeadersOptions` gains `parentThreadId` + `subagentLabel`; `buildHeaders` emits `x-codex-parent-thread-id` / `x-openai-subagent` only when truthy.

Tests: 4 passing (`packages/opencode-codex-provider/src/headers.test.ts`) — top-level skip, subagent full set, empty-sentinel handling, identity header invariants.

## Phase 3 — Anthropic `xhigh` effort for Opus 4.7+

Upstream ref: claude-cli v2.1.111 CHANGELOG (2026-03) — Opus 4.7 ships with an `xhigh` effort level above `high`. Our Anthropic branch in `transform.ts` previously returned only `low / medium / high`.

- `packages/opencode/src/provider/transform.ts` — Anthropic branch now returns `xhigh` for models whose id matches `claude-opus-4-N` where `N >= 7`, or whose `release_date >= "2026-03-19"`. Budget: `min(32_000, model.limit.output - 1)` — mirrors the OpenAI `xhigh` gate pattern at `transform.ts:533`.

Tests: 3 new passing (`packages/opencode/test/provider/transform.test.ts`):
- `claude-opus-4-7 gains xhigh variant`
- `claude-opus-4-6 does NOT expose xhigh` (gate negative)
- `xhigh budget is capped by model output limit minus one`

## Phase 4 — `disabled_providers` auto-only narrowing

Operator's intent (stated in hotfix plan §六 DD-9): `disabled_providers` should hide a provider from AUTO paths (default model selection, catalog listing) but NOT from EXPLICIT paths (`getModel(providerId, modelId)`, session-pinned accounts). Mirrors the manual-pin-bypass philosophy shipped in the pre-flight cooldown hotfix.

- `packages/opencode/src/provider/provider.ts::initState`:
  - Introduced an `autoHidden: Set<string>` sidecar.
  - Post-processing loop: after model curation, if `!isProviderAllowed(providerId)`, ADD to `autoHidden` instead of deleting the entry. Emits `log.info` with the provider id and model count — AGENTS.md 第一條.
  - `initState` return now includes `autoHidden`.
- `Provider.list()` — filters out auto-hidden entries for catalog iterators (TUI, CLI, REST).
- `Provider.listAllIncludingHidden()` — new internal accessor for admin / explicit flows (returns `state().providers` unchanged).
- `Provider.getModel(providerId, modelId)` — unchanged lookup semantics, **plus** `log.info` when the provider being resolved is in `autoHidden`, so operators can see explicit bypasses in their logs.

Tests: new case `explicit getModel resolves even when provider is in disabled_providers` (`packages/opencode/test/provider/provider-cms.test.ts`). The pre-existing sibling test `cms config providers remain available even when disabled_providers lists a core id` was failing on main (on the 5-failure baseline) — it now passes because `providers["openai"]` survives post-processing.

## Phase 5 — Submodule pointer bump + docs

- `refs/claude-code`: `1653669…` → `2b53fac…` (2026-04-16)
- `refs/codex`: `06e06ab173…` → `d0eff70383…` (2026-04-17)
- This incident record.

## Test summary

| Suite | Before | After | Delta |
|---|---|---|---|
| `codex-provider/src/auth.test.ts` (new) | — | 5 pass | +5 |
| `codex-provider/src/headers.test.ts` (new) | — | 4 pass | +4 |
| `test/provider/transform.test.ts` | 86 pass / 4 fail | 89 pass / 4 fail | +3 pass, 4 pre-existing failures unchanged |
| `test/provider/provider-cms.test.ts` | 3 pass / 2 fail | 4 pass / 1 fail | +1 pass (unblocked pre-existing), new Phase 4 test passes |
| `test/account/*` | 2 pass | 2 pass | unchanged |

Remaining failure (`cms admin-like nvidia api account shows provider model list`) is pre-existing on main and independent of this hotfix (fixture path not set in that test file).

## Cross references

- `plans/provider-hotfix/` — plan package (proposal / spec / design / tasks / handoff / idef0 / grafcet / c4 / sequence)
- `plans/manual-pin-bypass-preflight/` — sibling philosophy (auto-gate, not manual-gate) shipped 2026-04-17
- `specs/architecture.md` — "Provider Universe Authority" section augmented (see `§ disabled_providers runtime scope`)
- Upstream commits: codex-rs `22f7ef1cb7` (revoke), `9e19004bc2` (context-window headers); claude-cli v2.1.111 CHANGELOG (xhigh)
