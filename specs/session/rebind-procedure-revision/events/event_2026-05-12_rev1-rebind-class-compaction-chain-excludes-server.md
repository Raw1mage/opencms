---
date: 2026-05-12
summary: "rev1: rebind-class compaction chain excludes server-side; should include"
---

# rev1: rebind-class compaction chain excludes server-side; should include

# Revision 1 — rebind-class compaction chain missing server-side fallback

## Observation

Live tail (ses_1e56ed3f9ffebv4AaWOlcPLz20, 2026-05-12 14:34 onwards): every compaction event since rotation to humanresource account fired with `kind: "narrative"`. Server-side compaction (codex `/responses/compact` path, kind `low-cost-server`) was **never attempted**, despite being the preferred path per `feedback_compaction_two_principles.md` memory ("codex 善用 server-side compaction").

## Root cause

Not 429. Not network. **Not in the kind-chain table for rebind-class observed values.**

`packages/opencode/src/session/compaction.ts:871` — `KIND_CHAIN`:

| observed | chain order | includes `low-cost-server`? |
|---|---|---|
| `overflow` | narrative → replay-tail → low-cost-server → llm-agent | ✓ |
| `cache-aware` | narrative → replay-tail → low-cost-server → llm-agent | ✓ |
| `stall-recovery` | narrative → replay-tail → low-cost-server → llm-agent | ✓ |
| `manual` | narrative → low-cost-server → llm-agent | ✓ |
| `empty-response` | low-cost-server → narrative → replay-tail → llm-agent | ✓ (first try) |
| **`rebind`** | **narrative → replay-tail** | **✗** |
| **`continuation-invalidated`** | **narrative → replay-tail** | **✗** |
| **`provider-switched`** | **narrative → replay-tail** | **✗** |
| **`idle`** | **narrative → replay-tail** | **✗** |

The session's `info.json.recentEvents` shows 5 consecutive compactions all `observed: "rebind"` or `observed: "overflow"`, all `kind: "narrative"`. Rebind-class observed exclusively yields narrative.

## Why the original design excluded server-side from rebind chain

Implicit assumption at design time: rebind-class events imply "chain identity changed but context size is reasonable" → narrative summarisation is enough → server-side `/responses/compact` is overkill.

## Why that assumption fails in practice

The live data invalidates the assumption:
- Account rotation does NOT reduce conversation size (rotation switches credentials, not context — by design)
- A session that was already at high context volume retains that volume after rebind
- Rebind-triggered compaction therefore fires on a heavy context that **would benefit from server-side compact's deeper summarisation**, not narrative's faster but shallower summary
- Narrative compaction in this regime fills the context budget quickly, prompting another narrative within a few rounds — the user observed compactions firing back-to-back

## Proposed fix (one-line change in compaction spec)

In `packages/opencode/src/session/compaction.ts:872-877`:

```ts
rebind: Object.freeze(["narrative", "replay-tail", "low-cost-server", "llm-agent"] as const),
"continuation-invalidated": Object.freeze(["narrative", "replay-tail", "low-cost-server", "llm-agent"] as const),
"provider-switched": Object.freeze(["narrative", "replay-tail", "low-cost-server", "llm-agent"] as const),
```

Append `low-cost-server` and `llm-agent` to the rebind-class chains so they can fall through to the deeper compaction path when narrative + replay-tail leave the context heavy.

**Scope note**: this fix lives in compaction territory, not rebind territory. The spec to amend is `compaction/recall-affordance` (sibling) or the meta compaction spec, not this one. This event captures the observation; the amendment to compaction spec is a separate plan-builder cycle.

## Sibling spec to open

`compaction/kind-chain-rebind-extension` (proposed) — extend KIND_CHAIN for rebind-class observed values.

## Why record here as rev 1

The discovery surfaced WHILE working on session/rebind-procedure-revision and is a direct consequence of observing the new rebind protocol in production. The chain-init telemetry made the "always narrative" pattern visible; pre-this-work it would have been hidden inside generic compaction noise.

It's not strictly within scope (compaction kind ordering isn't this spec's responsibility), but the **finding-via-this-protocol's-telemetry** relationship is worth preserving. Future readers of this spec who hit similar `observed: rebind` heavy-context loops should be pointed at the sibling fix.

## Status

- [ ] Observation recorded (this event)
- [ ] Sibling spec opened to amend `compaction/...` KIND_CHAIN
- [ ] User decision: hotfix one-liner directly OR full spec cycle

## Operator note

If user opts for hotfix: change the 3 lines noted above, no other code changes needed; existing tests + dispatch pipeline continue working without modification. Expected effect: rebind-driven compactions will try server-side first (or as fallback in their chain), reducing the narrative-back-to-back pattern observed in this session.
