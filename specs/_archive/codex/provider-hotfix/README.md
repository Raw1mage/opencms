# Provider Hotfix (2026-04-18)

Formalized after `main` merge of `test/provider-hotfix` → `1ff8faeb6`. Promoted from `plans/provider-hotfix/` per beta-workflow §5 closeout.

## What this root owns

A bundled hotfix covering four upstream-sync + local-UX items that all surfaced together on 2026-04-18:

- **Phase 1** — codex logout revokes upstream OAuth refresh token (fail-closed). Mirrors codex-rs `22f7ef1cb7`. Entry points: `packages/provider-codex/src/auth.ts::revokeRefreshToken`, `packages/opencode/src/plugin/codex-auth.ts::logoutCodex`, pre-deletion hook in `packages/opencode/src/account/index.ts::remove`.
- **Phase 2** — codex `/responses` requests carry the 2026-04 context-window lineage headers (`x-codex-window-id`, `x-codex-parent-thread-id`, `x-openai-subagent`). Mirrors codex-rs `9e19004bc2`. Entry points: `session/llm.ts` sets opencode-side headers; `packages/provider-codex/src/provider.ts` reads them; `packages/provider-codex/src/headers.ts::buildHeaders` emits the upstream names.
- **Phase 3** — Anthropic `xhigh` effort variant for Opus 4.7+. Mirrors claude-cli v2.1.111 CHANGELOG. Entry point: `packages/opencode/src/provider/transform.ts` anthropic branch (gated by model id / release_date).
- **Phase 4** — `disabled_providers` narrowed from a global kill into an **auto-gate**. `Provider.list()` filters auto-hidden entries; `Provider.getModel(providerId, modelID)` still resolves so explicit pins and session-pinned flows are not silently blocked. Mirrors the manual-pin-bypass philosophy from `plans/manual-pin-bypass-preflight/` (shipped 2026-04-17).

## Additional scope landed in the merge

- Submodule pointer bumps: `refs/claude-code` `1653669` → `2b53fac`, `refs/codex` `06e06ab173` → `d0eff70383`.
- **Webapp footer quota polling** (post-Phase-5 follow-up on the test branch): the session footer now polls the usage endpoint every 10 s while the session is busy, plus per-turn invalidate + `?fresh=1`. Needed because subagent (task tool) runs kept the parent session busy for 10+ minutes without emitting any parent-level assistant completion, so the prior per-completion refresh alone could not keep the display current. `codex` added to the quota-provider whitelist (`packages/app/src/components/prompt-input/quota-refresh.ts`).

Wham/usage is a metadata endpoint with no token cost — the 10 s cadence is safe.

## How to read this root

- `proposal.md` — operator incident + effective requirements.
- `spec.md` — GIVEN/WHEN/THEN per requirement.
- `design.md` — DD-1 through DD-10 (DD-8 in particular documents why `isProviderAllowed` runtime semantics stayed additive).
- `implementation-spec.md` — execution contract with stop gates and phase boundaries.
- `tasks.md` — per-phase task checklist (post-merge: all phases checked off).
- `handoff.md` — executor instructions used during build mode.
- `idef0.json` / `grafcet.json` — functional decomposition and state machine for the hotfix flow.
- `c4.json` / `sequence.json` — component layout and three runtime scenarios (logout revoke, headered request, explicit-bypass-of-disabled).

## Implementation truth

- `packages/provider-codex/src/auth.ts` + `auth.test.ts` — revoke helper.
- `packages/provider-codex/src/headers.ts` + `headers.test.ts` — context-window header builder.
- `packages/provider-codex/src/provider.ts` — header threading from opencode-side request headers.
- `packages/opencode/src/plugin/codex-auth.ts` — logout wrapper with fail-closed logging.
- `packages/opencode/src/account/index.ts::remove` — pre-deletion revoke hook.
- `packages/opencode/src/session/llm.ts` — opencode-side header plumbing + `resolveParentSessionID` helper.
- `packages/opencode/src/provider/provider.ts` — `autoHidden` sidecar, `list()` / `listAllIncludingHidden()` / `getModel()` adjustments.
- `packages/opencode/src/provider/transform.ts` — Anthropic branch `xhigh` for Opus 4.7+.
- `packages/app/src/components/prompt-input.tsx` — footer quota polling loop, per-turn invalidate, `pendingFreshQuotaLoad` signal.
- `packages/app/src/components/prompt-input/quota-refresh.ts` — provider whitelist (adds `codex`), 5 s throttle.

## Incident trail

- `docs/events/event_2026-04-18_provider_hotfix.md` — post-merge incident record covering all four phases.
- `plans/manual-pin-bypass-preflight/` — sibling hotfix (shipped 2026-04-17) that established the auto-gate-vs-explicit-use philosophy extended here by Phase 4.
- Upstream refs: codex-rs `22f7ef1cb7` (revoke), `9e19004bc2` (context-window headers); claude-cli v2.1.111 CHANGELOG (xhigh).

## Status

All four phases merged to `main` at commit `1ff8faeb6` (2026-04-18). Live verification by operator confirmed the Phase 4 `openai` explicit-selection path works end to end and the Phase 2 headers travel on real codex requests. `refs/` submodules advanced to the analysis baseline. No new test failures vs. main baseline (5 pre-existing failures unchanged).
