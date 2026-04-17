# Design: Codex Rotation Hotfix

## Context

- Rotation pipeline: `packages/opencode/src/session/llm.ts::handleRateLimitFallback` → `packages/opencode/src/account/rotation3d.ts::findFallback / buildFallbackCandidates` → candidate scoring per strategy.
- Rate-limit classification: `packages/opencode/src/account/rate-limit-judge.ts::fetchCockpitBackoff` (proactive) + `packages/opencode/src/account/rotation/backoff.ts::parseRateLimitReason` (reactive). Strategies are per-provider: `"cockpit"` / `"counter"` / `"passive"`.
- Quota data source: `packages/opencode/src/account/quota/openai.ts::getOpenAIQuota` calls `https://chatgpt.com/backend-api/wham/usage`. The endpoint accepts the **same** OAuth bearer used by the codex subscription flow (codex tokens ARE ChatGPT subscription tokens — we copied 6 of them earlier today and the 401 the other day was on `api.openai.com`, a different surface). So the cockpit endpoint works for codex accounts as-is.
- Today's state before this hotfix: openai is "cockpit", codex is "passive" — codex never gets the proactive check.
- Earlier hotfix (`plans/manual-pin-bypass-preflight/`) established the principle: don't silently block explicit user intent. This plan extends the same principle — don't silently cross-provider-fallback when the operator explicitly picked codex.

## Goals / Non-Goals

**Goals:**
- Codex exhaustion detection matches openai (proactive + reactive).
- Rotation candidate filtering honors codex quota.
- Codex family stays within codex family on fallback (hard-coded, no config).
- Every new skip / mark is observable (AGENTS.md 第一條).

**Non-Goals:**
- Changing openai behavior.
- Adding a config flag for "same-provider-only" — operator explicitly rejected Option B.
- Unifying openai + codex as a single "ChatGPT subscription" family — they remain distinct provider ids; the ONE thing they share is the quota endpoint, and only that is reused.
- Refactoring rate-limit-judge strategy enum or rotation3d scoring beyond the minimum delta.

## Decisions

- **DD-1 Codex reuses the openai cockpit path, not a new strategy.** Rationale: same endpoint, same response shape, same token format. A separate strategy would double the code surface and drift risk. Concretely: the `providerId === "openai"` gate at `rate-limit-judge.ts:543` becomes a provider-family check that accepts both.

- **DD-2 The provider-family check uses `Account.resolveFamily(providerId)` (or an explicit allow-list).** Rationale: there are aliases (`openai-subscription-*` account ids vs `"openai"` family; codex ids vs `"codex"` family). A lookup mirrors how other parts of the codebase normalize provider ids.

- **DD-3 Quota filtering in `rotation3d.ts:596-605` extends to codex family, mirroring openai.** Rationale: same quota shape (`hourlyRemaining` / `weeklyRemaining`), same `<= 0` semantics. The only edit is the `if (vector.providerId === "openai")` → `if (family is openai or codex)`. Keep the early-exit for non-quota providers intact; no performance regression.

- **DD-4 Codex family-only enforcement is implemented inside `buildFallbackCandidates`, not in `llm.ts`.** Rationale: the candidate builder is the single point where all family-aware metadata is already in scope; pushing the check up to `llm.ts` would require re-deriving family info. Concretely: when the `currentVector.providerId` resolves to codex family, drop any candidate whose family is not codex BEFORE scoring.

- **DD-5 Codex-only gate is hard-coded in-function, no config.** Rationale: user explicitly chose Option A. A future tweaks.cfg knob can invert this later without breaking existing operators.

- **DD-6 Empty candidate pool surfaces CodexFamilyExhausted error** (subclass of existing rotation error or a new NamedError). Rationale: the existing "all accounts rate-limited" generic error (from preflight in `processor.ts:580-591`) is codex-agnostic and doesn't guide the operator. A codex-specific message ("all codex subscription accounts are 5H / weekly exhausted; wait for reset or switch provider manually") gives actionable feedback.

- **DD-7 Belt-and-suspenders: extend `backoff.ts::parseRateLimitReason` with codex-specific patterns.** Rationale: cockpit can miss (cache lag, upstream flakiness) — the passive path must still classify correctly when a real 5H error body arrives. New patterns: 5-hour window, response_time_window, usage-limit-reached/exceeded → QUOTA_EXHAUSTED. Keep the existing quota-keyword check as the general net.

- **DD-8 Cockpit failure falls back to passive, not to "assume healthy".** Rationale: if the `wham/usage` endpoint is down, we shouldn't pretend the account is fine. Current behavior for openai is already this (passive on failure); codex inherits the same semantic by routing through the same path.

- **DD-9 Observability: one log line per new decision branch.** Rationale: AGENTS.md 第一條 + operator needs to be able to grep the log and trace what the daemon did on a 5H hit. Keep the log lines terse and structured (account id, family, reason).

- **DD-10 No change to session telemetry / bus events.** Rationale: the webapp already polls `/api/v2/account/quota` (the 10s poller we shipped earlier today). Rotation decisions are inherently backend; adding bus events for each candidate-skip would be chatty. If the operator needs the data in the UI later, add a single rotation.decided event in a follow-up.

## Data / State / Control Flow

Before (current state):

```
request → llm.stream → processor pre-flight
                       openai branch: cockpit check — wham/usage — 5H? backoff + rotate
                       codex  branch: passive only  — fire request — stall / generic error
                                                     — rotation candidate pool
                                                       openai candidates filtered by quota OK
                                                       codex  candidates NOT filtered MISSING
                                                     — same-provider preferred (+300)
                                                     — falls through to OTHER providers if exhausted
```

After:

```
request → llm.stream → processor pre-flight
                       openai branch: cockpit check (unchanged)
                       codex  branch: cockpit check (NEW, same endpoint, same logic)
                                      exhausted → backoff + rotate
                                      healthy → fire request
                                                any error → rotation candidate pool
                                                  openai candidates filtered (unchanged)
                                                  codex candidates filtered by quota (NEW)
                                                  if current=codex:
                                                    drop non-codex candidates (NEW)
                                                    if empty → throw CodexFamilyExhausted
                                                  same-provider preferred (unchanged for other providers)
```

## Risks / Trade-offs

- **Risk: cockpit polls increase load on `wham/usage`.** → Mitigation: existing cache TTL (60s via `OPENAI_QUOTA_DISPLAY_TTL_MS`) applies to codex accounts too; no extra endpoint calls beyond what already happens for openai. In practice codex users have 1-6 accounts, so ≤6 polls / 60s ceiling.

- **Risk: false positive (cockpit says exhausted when it isn't).** → Mitigation: cockpit uses `<= 0` threshold on upstream-reported numbers; the upstream dashboard is the source of truth. If operator suspects drift, they can manually reset via `POST /:family/:accountId/reset-cooldown` (existing endpoint).

- **Risk: operator loses the cross-provider escape hatch for codex.** → Justification: they explicitly asked for it. An `opencode/anthropic/gemini` manual selection remains possible via the TUI / webapp — the hotfix only affects *automatic* rotation when the current vector is codex. Surfacing CodexFamilyExhausted makes the escape-hatch action explicit.

- **Risk: belt-and-suspenders patterns in `backoff.ts` conflict with future upstream message changes.** → Mitigation: patterns are scoped to codex-known strings only; existing general quota-keyword catch remains as the safety net.

- **Trade-off: hard-coded codex-only vs. config flag.** → Operator chose hard-coded (Option A) for simplicity. Future Option B (config flag) can be added without breaking the current behavior — keep the codex-only check localized so it can be replaced by a config lookup cleanly.

## Critical Files

- `packages/opencode/src/account/rate-limit-judge.ts` — cockpit gate; minor provider-family lookup.
- `packages/opencode/src/account/rotation3d.ts` — buildFallbackCandidates (quota filter extension; family-only gate new).
- `packages/opencode/src/account/rotation/backoff.ts` — passive classification patterns.
- `packages/opencode/src/session/llm.ts` — handleRateLimitFallback return-null path emits CodexFamilyExhausted.
- `packages/opencode/src/account/quota/openai.ts` — no code changes; existing getOpenAIQuota is reused for codex accounts (same endpoint, same token).
- New test files / extensions under `packages/opencode/test/account/`.
- New `docs/events/event_2026-04-18_codex_rotation_hotfix.md`.

## Supporting Docs (Optional)

- `specs/codex/provider-hotfix/` — sibling hotfix family shipped earlier today.
- `plans/manual-pin-bypass-preflight/` — precedent for honor-explicit-operator-intent.
