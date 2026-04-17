# Proposal: Codex Rotation Hotfix

## Why

- **Codex 5H exhaustion is invisible to the daemon.** The cockpit quota poller in `packages/opencode/src/account/rate-limit-judge.ts:543` only runs for `providerId === "openai"`. codex is classified `"passive"` (`rate-limit-judge.ts:139`) so exhaustion is detected only if the upstream error arrives with a clear message — but `chatgpt.com/backend-api/codex/responses` often silently stalls the SSE / WS stream on 5H hit, or returns a generic body the backoff parser cannot recognize. Result: program stalls, no rotation.
- **Rotation candidate pool ignores codex quota.** `rotation3d.ts:596-605` marks a candidate `isQuotaLimited` only when `vector.providerId === "openai"`. codex accounts that are already 5H-exhausted pass the filter and get picked as "fallbacks" — rotation jumps to an equally-dead account, the stall repeats.
- **Cross-provider fallback violates operator intent for codex.** Current default `"account-first"` strategy with `allowSameProviderFallback: true` gives same-provider a +300 scoring bonus but still falls through to other providers when same-provider candidates are exhausted. Operator wants codex family to stay within codex even if all codex accounts are dead — better to surface a clear error than silently switch to anthropic/gemini.

Left untreated this accumulates: frozen sessions the operator must manually interrupt, fallback to the wrong provider when a real codex pause is warranted, and no observability into which codex account is in which quota state.

## Original Requirement Wording (Baseline)

- "針對 rotation 做一個 hotfix。目前的 codex provider 遇到 5H 用量竭盡的時候，沒有辦法判斷事件並觸發 rotation，會使程式停下來。這是第一個要修的。"
- "第二個是 rotation 的原則，如果當下使用的是 codex provider 的話，要從同一 provider 的不同帳號中去找 5H 用量有剩餘且週用量也有剩餘者。"
- "A. codex family 硬性 same-provider-only（內建行為，不給 config）"

## Requirement Revision History

- 2026-04-18 v0 — three gaps identified. Phase 3 scope pinned to option A (hard-coded codex-family-only, no config knob) per operator decision.

## Effective Requirement Description

1. **Codex 5H exhaustion MUST be proactively detectable.** The cockpit quota-check path (currently openai-only) SHALL run for codex family too, using the same `chatgpt.com/backend-api/wham/usage` endpoint, so the daemon can return a backoff / rotation trigger before (or the moment) a request dies on 5H.
2. **Rotation candidate filtering MUST honor codex 5H + weekly quota.** The `isQuotaLimited` gate that currently skips quota-dead openai accounts SHALL also skip codex accounts whose `hourlyRemaining <= 0` OR `weeklyRemaining <= 0`. Candidates entering the ranked fallback pool must have headroom on both windows.
3. **Codex family MUST rotate only within codex family.** When the current vector's provider is codex and rotation fires, fallback selection SHALL NOT return candidates whose provider is anything other than codex. If no codex candidate is available, surface a clear error rather than cross-provider fallback. This is hard-coded (no config flag).
4. **All fallback paths remain observable (AGENTS.md 第一條).** Every new skip / every new proactive mark SHALL log a single line identifying the account and the reason (exhausted / rotated / no-candidate / cross-provider-blocked).

## Scope

### IN

- Extend the cockpit strategy enumeration in `rate-limit-judge.ts` to cover codex family — same endpoint, same `getOpenAIQuota` data shape, just the `providerId === "openai"` gate at line 543 expanded to `provider in {openai, codex}` (via `Account.resolveFamily` or an allow-list).
- Extend quota filtering in `rotation3d.ts:596-605` (`isQuotaLimited`) so codex accounts with exhausted 5H or weekly quota are excluded from candidate list.
- Add a hard-coded codex-family-only guard in `rotation3d.ts::buildFallbackCandidates` (or the caller in `llm.ts::handleRateLimitFallback`): when `currentVector.providerId === "codex"`, reject candidates whose provider is not codex. Emit `log.info` with the skip reason.
- Surface a dedicated error class / user-facing message when all codex candidates are exhausted ("all codex accounts are 5H / weekly exhausted; try again later or switch provider manually").
- Unit tests covering: (a) codex detects 5H via cockpit, (b) exhausted codex accounts filtered out of candidate pool, (c) codex-family-only returns null when no codex candidate, (d) classification of codex 5H error message patterns (best-effort passive path still works if cockpit missed).
- `docs/events/` entry + plan.md.

### OUT

- Changing openai provider behavior (already has cockpit + quota filtering).
- New config flag for `sameProviderOnly` or similar — explicitly rejected in favor of hard-coded codex-family-only.
- Webapp UI changes (footer already polls `/api/v2/account/quota`; this hotfix only changes backend selection logic).
- Cross-family aliasing (e.g. "let codex fall back to openai because they share ChatGPT subscription"). Out of scope — operator wants strict codex-only.
- Refactoring `rate-limit-judge.ts` strategy classification beyond adding codex to the cockpit path.

## Non-Goals

- Full rewrite of rotation3d or rate-limit-judge.
- Introducing tweaks.cfg for these thresholds (infrastructure doesn't exist yet; separate concern).

## Constraints

- AGENTS.md 第零條: this plan satisfies plan-first.
- AGENTS.md 第一條: every new branch must emit observable log; no silent fallback.
- No webapp / TUI protocol changes — backend rotation is self-contained.
- Hot path: `rotation3d.ts::buildFallbackCandidates` runs on every rate-limit / fallback trigger. Keep the new check O(1) per candidate; do not widen the function's time complexity.

## What Changes

- `packages/opencode/src/account/rate-limit-judge.ts` — cockpit strategy case covers codex family; the `providerId === "openai"` gate at the fetch call expands to accept codex; classification rules in `packages/opencode/src/account/rotation/backoff.ts` gain codex-specific 5H patterns as a belt-and-suspenders passive path.
- `packages/opencode/src/account/rotation3d.ts` — `isQuotaLimited` check includes codex family; `buildFallbackCandidates` drops non-codex candidates when `currentVector.providerId === "codex"`.
- New error class (or extension of existing) to carry "all codex accounts exhausted" case, surfaced via `packages/opencode/src/session/llm.ts::handleRateLimitFallback` when `findFallback` returns null under codex-family-only mode.
- Unit tests under `packages/opencode/test/account/` and/or `packages/opencode/test/provider/`.

## Capabilities

### New Capabilities

- **Codex cockpit quota monitoring** — proactive 5H / weekly check mirroring openai.
- **Codex quota-aware rotation** — exhausted accounts excluded from candidate pool.
- **Codex family boundary** — rotation explicitly refuses cross-provider escape for codex.

### Modified Capabilities

- **`isQuotaLimited` candidate flag** — broadened to codex.
- **`findFallback` / `buildFallbackCandidates`** — provider-boundary aware for codex family.

## Impact

- `rate-limit-judge.ts` cockpit path now hits `chatgpt.com/backend-api/wham/usage` for codex accounts on the same cadence as openai — no new endpoint, no new auth, same request shape.
- Rotation will more frequently return null for codex if the operator's entire codex account pool is exhausted, instead of rotating to a foreign provider. The UI / TUI will display the codex-specific error message introduced by this plan.
- No webapp protocol change; the footer quota polling we shipped earlier continues to work unchanged.
- New docs/events entry — `docs/events/event_2026-04-18_codex_rotation_hotfix.md`.
