# 2026-04-17 — Manual Pin Bypasses Pre-flight Cooldown Gate

## Incident

Operator had explicitly pinned `codex-subscription-ivon0829-gmail-com` on a session. Every new message surfaced `"All accounts for codex are rate-limited. Please wait a few minutes."` The operator manually reset the rate-limit state via `POST /:family/:accountId/reset-cooldown` and the account worked again — no other changes. The rate limit was stale state in the tracker, not a real upstream limit.

## Root Cause

`packages/opencode/src/session/processor.ts:429` — pre-flight cooldown gate was not guarded by the manual/auto distinction:

```ts
if (isVectorRateLimited(vector)) {       // fires regardless of pin
  // rotation / child-session escalation / circuit-breaker
}
```

The sibling guard at `packages/opencode/src/session/llm.ts:354` already had `!sessionPinnedAccountId` — but the processor-level gate one layer up hit first, rotated away from the pinned account, and when no same-provider alternative was healthy, surfaced the "all accounts rate-limited" error.

Stale state source: `~/.local/state/opencode/rotation-state.json` persists tracker cooldowns across daemon restarts and across sibling sessions. A 429 from yesterday (or from another session) could silently block today's explicit user request.

## Fix

`processor.ts:429` — add the same guard the LLM-level gate already has:

```ts
if (isVectorRateLimited(vector) && !sessionPinnedAccountId) {
  // rotation path
}
```

Semantics:

- **Auto path** (no explicit pin): pre-flight still rotates away from rate-limited accounts. This remains the flood-protection story for auto rotation.
- **Manual path** (operator explicitly pinned): pre-flight no longer rotates. The request fires; upstream returns a real 429 if the limit is actually in effect, which `RateLimitJudge` then marks. Mid-stream retry gates (unchanged) can still rotate based on that real evidence.

## Tests

- `packages/opencode/test/session/preflight-cooldown-guard.test.ts` — source-level trip-wire that asserts the `&& !sessionPinnedAccountId` clause remains present on the gate. A full E2E mock of the processor pre-flight would require rebuilding the stream harness; for a one-line guard, a grep-style assertion is proportional.
- `session/llm-rate-limit-routing.test.ts` / `llm.test.ts` / `retry.test.ts`: 28 pass / 1 fail — identical to main baseline (pre-existing failure, not caused by this change).
- `config/*` / `provider/availability.test.ts`: 109 pass.

## Out of Scope

- `/rotation/recommend` and `/rotation/status` REST endpoints still filter rate-limited accounts. These are UI hints (the TUI uses them to style the model picker). If the TUI also needs to respect manual override visually, that is a UI-side follow-up.
- `isModelAvailable` / `selectSubscriptionModel` are internal auto-selection — flood protection stays.

## Branch

Landed on `test/config-restructure` bundled with Phases 1+2+3 of `plans/config-restructure/` per operator direction. Hotfix plan recorded at `plans/manual-pin-bypass-preflight/plan.md`.

## Cross References

- `plans/manual-pin-bypass-preflight/plan.md`
- `packages/opencode/src/session/processor.ts:429`
- `packages/opencode/src/session/llm.ts:354` (sibling gate already guarded)
- `packages/opencode/src/account/rotation/rate-limit-tracker.ts` (state source)
- `~/.local/state/opencode/rotation-state.json` (persistence)
