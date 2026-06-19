# Dispatcher Dedup — Whitelist Model

**Status**: living (merged to main `3eea74a0b`, 2026-06-19)
**Family**: session / tool dispatcher
**Source plan**: `plans/dispatcher_kill-silent-dedup-cache/`
**Code**: `packages/opencode/src/tool/tool.ts` (`isDedupEligible`), `packages/opencode/src/session/tool-invoker.ts` (two-layer dedup gate)

## What

The tool dispatcher's identical-call dedup is now a **whitelist**: default is RE-RUN; only `apply_patch` short-circuits. Previously it was a blacklist (default dedup, with native-modify + non-readOnly-MCP exceptions), which silently short-circuited side-effecting MCP calls — notably `docxmcp_pptx_bootstrap(overwrite=true)`.

```ts
export function isDedupEligible(toolID: string): boolean {
  return DEDUP_KEPT_MODIFY_TOOLS.has(toolID)   // {apply_patch}
}
```

## Why (evidence-driven, user-directed)

1. **Reads cost the same tokens cached or fresh.** Deduping read/query tools buys no token savings, only staleness risk. The original commit's "saves user tokens" was a mislabel (it saved compute/IO, not tokens).
2. **`idempotentHint` ≠ dedup-safe.** Idempotent (PUT semantics) = re-running mutates state but converges to the same final state ≠ "safe to skip". When intermediate state changed (a marker shape added), the PUT must actually re-run. The old MCP branch `readOnlyHint || idempotentHint` treated `bootstrap`'s `idempotentHint:true` as cacheable → silent no-op → slide never reset.
3. **apply_patch dedup is the sole load-bearing case.** 30-day production scan (726 session DBs): 4504 apply_patch calls, 90 dedup hits — mostly the model RE-SENDING an already-SUCCEEDED patch. Removing it would turn those into real re-runs (mostly noisy oldString-not-found + rotation churn). Kept.

## Origin (archaeology)

The 2026-05 spec `session_tool-retry-and-dedup` introduced dedup to stop the model re-sending failed apply_patch 4-5×. That spec ALREADY concluded the behavior-layer retry hint (`[skip-mutation]`) was "the primary lever" and dedup was damage control for "model behavior, out of scope". The whitelist reframe finishes that unwalked step: keep the one load-bearing guard, drop the rest, and never silently pretend a side-effecting call ran.

## Retained but inert

`dedupHintsRegistry` / `registerDedupHints` (populated by `mcp/index.ts:1757` from MCP annotations) are kept for observability and possible future per-tool policy, but `isDedupEligible` no longer consults them.

## Validation

- `tool.dedup-eligible.test.ts`: 8 pass (rewritten for whitelist semantics + idempotentHint bootstrap regression guard)
- `tool-invoker.dedup.test.ts`: 21 pass (two-layer gate still honors isDedupEligible; apply_patch still dedups)
- changed files typecheck: 0 error
- Implemented via beta-workflow (beta/dedup-whitelist → test/dedup-whitelist → main, disposable surfaces cleaned)

## Related

- `issues/closed/bug_20260619_dispatcher_dedup_eats_side_effecting_toolcall.md`
- `issues/closed/bug_20260619_dispatcher_dedup_short_circuits_forced_rebuild.md`
- docxmcp BR (F1–F5): the bootstrap symptom that surfaced this
