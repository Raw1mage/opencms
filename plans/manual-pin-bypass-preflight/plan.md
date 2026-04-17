# Manual-Pin Bypasses Pre-flight Cooldown

**Type**: Hotfix (AGENTS.md 第零條 exempt — production-blocking bug)
**Date**: 2026-04-17
**Branch**: `test/config-restructure` (bundled with Phase 1+2+3 of plans/config-restructure per user direction)

## 一、症狀

User explicitly pinned `codex-subscription-ivon0829-gmail-com` on a session. Every new request surfaced `"All accounts for codex are rate-limited. Please wait a few minutes."` even though upstream codex was accepting requests fine. User manually reset rate-limit state via the admin dialog (which calls `POST /:family/:accountId/reset-cooldown`) and the account immediately started working again, with no other changes.

In other words: **a persisted cooldown in the tracker silently overrode the user's explicit pin** and prevented the request from ever reaching upstream.

## 二、Root Cause

`packages/opencode/src/session/processor.ts:429` — pre-flight cooldown gate:

```ts
const sessionPinnedAccountId = explicitAccountId ?? sessionExecution
const accountId = sessionPinnedAccountId ?? (family ? await Account.getActive(family) : undefined)
...
if (isVectorRateLimited(vector)) {
  // rotation / escalation / circuit-breaker path
}
```

The gate fired regardless of whether the account was pinned by the user or picked by the daemon from `Account.getActive(family)`. When the tracker's persisted `rotation-state.json` carried an old cooldown (e.g. an earlier 429 from yesterday or from a sibling session), the manual pin was rotated away, and if no healthy same-provider account was available, the request failed with the "all accounts rate-limited" error.

The sibling gate at `packages/opencode/src/session/llm.ts:354` already guarded with `!sessionPinnedAccountId` — the pre-flight SWAP there does not fire for manual pins. But the parallel gate in `processor.ts` did not share that guard, so the blocking path triggered anyway one layer up.

## 三、Design Contract

User-stated intent:

> cooldown protection 只針對 auto rotation 做防 flooding，不要擋人為的行為

Formalized:

- **Auto path** (no explicit pin, daemon resolved account from global active): pre-flight cooldown gate STAYS — it spares upstream from flooding and lets rotation pick a healthy account.
- **Manual path** (operator passed `accountId`, or session's pinned execution identity holds): pre-flight cooldown gate is SKIPPED. Fire the request. If upstream is genuinely rate-limited it returns 429; `RateLimitJudge` then marks the vector and the mid-stream retry can rotate legitimately (it has real evidence, not stale state).

Mid-stream gates (`processor.ts:1298/1411/1524`) are untouched: they react to a real 429 that just happened on the current request, not to persisted state. Those remain valuable even on manual paths.

## 四、Fix

One-line guard at `processor.ts:429` — add `&& !sessionPinnedAccountId` so the pre-flight rotation only triggers for auto-resolved accounts.

Plus a source-level trip-wire regression test (`packages/opencode/test/session/preflight-cooldown-guard.test.ts`) so accidental future refactors can't silently remove the guard.

## 五、Files

- [packages/opencode/src/session/processor.ts](../../packages/opencode/src/session/processor.ts) — pre-flight gate guard
- [packages/opencode/test/session/preflight-cooldown-guard.test.ts](../../packages/opencode/test/session/preflight-cooldown-guard.test.ts) — new regression
- [docs/events/event_2026-04-17_preflight_manual_pin_bypass.md](../../docs/events/event_2026-04-17_preflight_manual_pin_bypass.md) — incident record

## 六、Validation

- New regression test passes.
- `session/llm-rate-limit-routing.test.ts` / `session/llm.test.ts` / `session/retry.test.ts`: 28 pass, 1 fail — identical failure to main baseline (pre-existing), **zero new regressions** introduced by this change.
- `config/` + `provider/availability.test.ts`: 109 pass.

## 七、AGENTS.md 合規

- 第零條：本來需 plan 先行，但這是阻斷使用者操作的 hotfix，適用「Hotfix 例外」。Plan 補於本文件。
- 第一條（禁止靜默 fallback）：修復方向本身就是「不再讓系統靜默地用 tracker state 覆蓋 user intent」，正好符合第一條精神。
- Release 前檢查清單：`docs/events/` 已記錄；`specs/architecture.md` 的 "Rotation" / "Rate Limit" 段落已在 Phase 2 期間記載 availability layer，本 hotfix 僅調整 call-site 守衛，無需結構性文件變更。

## 八、Out of Scope (Follow-up)

- `/rotation/recommend` + `/rotation/status` REST endpoints also filter rate-limited accounts unconditionally. Today the TUI uses them to style the model picker. If the UI also needs to respect manual override (e.g. "let me still click this greyed-out account"), that is a separate UX change tracked elsewhere.
- `isModelAvailable` in `provider.ts:2418` (used by small-model/summary selection) still filters rate-limited. That is internal automation and should continue to have flood protection; no change proposed.
- `selectSubscriptionModel` in `default-model.ts` is purely auto-resolution and stays guarded.
