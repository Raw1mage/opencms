---
date: 2026-05-11
summary: "production: codex team-plan shared quota exhaustion + identity-preserve fix validated by 7-event recentEvents trace"
---

# production: codex team-plan shared quota exhaustion + identity-preserve fix validated by 7-event recentEvents trace

## Session

`ses_1e738d1c8ffeen3y8zPoXjsQ02` at 2026-05-12 07:28+08:00 — codex/gpt-5.5, working on `/specs/` grafcet svg generation.

## Symptom (user-visible)

AI's `attachment` tool (called to inspect a user-uploaded image) failed with:

```
Codex API error (429): {
  "error": {
    "type": "usage_limit_reached",
    "message": "The usage limit has been reached",
    "plan_type": "team",
    "resets_at": 1778586331,
    "eligible_promo": null,
    "resets_in_seconds": 44245
  }
}
```

`resets_in_seconds ≈ 12 hours`. User saw this as an "奇怪 bug" — expected rotation to recover.

## Diagnosis

Pulled from `session.execution.recentEvents` (a 7-entry ring buffer, ordered chronologically):

```
ts=1778537867482  compaction  observed=rebind  kind=narrative  success=true
ts=1778538984178  compaction  observed=rebind  kind=narrative  success=true
ts=1778539443746  rotation    codex/developer    → codex/business         reason=RATE_LIMIT_EXCEEDED
ts=1778539858290  rotation    codex/business     → codex/humanresource    reason=RATE_LIMIT_EXCEEDED
ts=1778540289416  compaction  observed=rebind  kind=narrative  success=true
ts=1778541502378  compaction  observed=rebind  kind=narrative  success=true
ts=1778541897861  rotation    codex/humanresource → codex/service         reason=RATE_LIMIT_EXCEEDED
[then at 07:28] codex/service ALSO hits 429 — usage_limit_reached, plan_type=team
```

All four codex accounts (developer / business / humanresource / service) hit `usage_limit_reached` with `plan_type=team`. They share the SAME daily team-plan quota. Rotating between them is by-design rate-limit recovery — it does NOT help when the underlying quota is a single shared pool.

## Two distinct error semantics conflated

- **Per-account rate limit** (transient, seconds–minutes): rotation recovers.
- **Team-plan usage limit** (hard quota, ~12hr reset): rotation is futile — all member accounts share the cap.

The rotation engine treats both as `RATE_LIMIT_EXCEEDED` and rotates anyway. When the entire team plan is exhausted, rotation just shuffles between equally-exhausted accounts until the final one bubbles the 429 to the tool caller.

## Side observation: 15-line same-ms log was not a retry storm

debug.log showed 15 `tool-call` error entries at `07:28:32.189` with identical callID. `seq` numbers were consecutive (79821..79835). This is a single tool call whose telemetry was fanned out to 15 log subscribers, not a retry loop. No functional impact, but visually alarming.

## Validation of f79375ec1 (identity-preserve fix)

This is the **first production trace** where recentEvents survived multiple account rotations within a single session — pre-fix, every `nextExecutionIdentity` call dropped the ring buffer. Today's 7-event chain (4 compactions + 3 rotations across 4 accounts) demonstrates the fix is doing its job:

- L3 amnesia_notice has stable signal about active anchor kind even after 3 rotations.
- Operator-side debug (this RCA) was only possible because the chronology was preserved.

The fix's load-bearing value goes beyond recall-affordance L3 — any feature that needs cross-rotation signal continuity (attachment-lifecycle activeImageRefs, future rotation analytics, ops dashboards) inherits the same reliability.

## Recommended follow-ups (not in this spec's scope)

1. **`usage_limit_reached` should NOT trigger rotation** (or should rotate only across distinct plans/orgs, not within a single team-plan pool). Detect `error.type === "usage_limit_reached"` and surface a "wait for reset" state instead of futile rotation.
2. **Team-plan quota aggregation**: when one team-account hits `usage_limit_reached`, mark sibling team accounts as exhausted with the same `resets_at` so rotation doesn't waste a turn discovering each one is also dead.
3. **Telemetry fanout audit**: 15-way duplication on every tool-call error is wasteful even if functionally inert. Worth checking whether one of the subscribers is leaking (e.g. SSE listeners not being cleaned up on disconnect).

