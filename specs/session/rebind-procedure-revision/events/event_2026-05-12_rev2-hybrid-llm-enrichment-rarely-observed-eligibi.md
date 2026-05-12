---
date: 2026-05-12
summary: "rev2: hybrid_llm enrichment rarely observed — eligibility excludes rebind + no telemetry surface"
---

# rev2: hybrid_llm enrichment rarely observed — eligibility excludes rebind + no telemetry surface

# Revision 2 — Hybrid enrichment structurally unreachable for rebind-driven compactions, AND silent when it does fire

## Observation

User reported (paraphrased): "I configured background LLM refinement to consolidate stacked anchors into a single quality anchor, but I rarely see it happen."

The intent referenced is the `hybrid_llm` background enrichment path. After a synchronous narrative compaction succeeds, the runloop is supposed to fire a background `hybrid_llm` LLM call that re-summarises the anchor body into something tighter, then overwrites the narrative anchor's body in place. This solves the chained-narrative growth problem (rev1: `anchor[n+1] = anchor[n] ⊕ tail` keeps growing linearly).

## Verified findings

### Finding 1 — Eligibility set excludes all rebind-class observed values

`packages/opencode/src/session/compaction.ts:2159`:

```ts
const hybridEnrichmentEligible: ReadonlySet<Observed> = new Set(["overflow", "cache-aware", "manual"])
```

Rebind-class observed values (`rebind`, `continuation-invalidated`, `provider-switched`, `idle`, `stall-recovery`, `empty-response`) are not in this set. They never trigger `scheduleHybridEnrichment` even after a successful narrative anchor write.

Live data point: in session ses_1e56ed3f9ffebv4AaWOlcPLz20's `info.json.recentEvents`, 4 of the 5 recorded compactions are `observed: "rebind"` (and the 5th is `overflow`). So 80% of this session's compactions had no eligibility check pass to begin with.

### Finding 2 — `hybrid_llm` enrichment emits no RuntimeEventService events

Searched the session's runtime event journal (315 prompt + 310 round + 42 rebind + 31 chain.* + 1 compaction events total across the session lifetime). **Zero events mentioning `hybrid_llm`, `enrich`, or `hybrid`.**

Inspection of `scheduleHybridEnrichment` at `compaction.ts:1607-1772` confirms: the whole code path uses only `log.info(...)` / `log.warn(...)` calls. There is no `RuntimeEventService.append(...)` at any step (start, in-progress, success, fail).

Consequence: even when `hybrid_llm` enrichment IS triggered (in the eligible cases), it runs silently in the background. No telemetry. No `session.compaction.*` event. No way for an operator or dashboard to know it ran. The only signal is the eventual change in the anchor body content — observable only by reading the anchor message directly.

### Finding 3 — Single eligible compaction in this session: unverified whether enrichment fired

The one `observed: "overflow"` compaction in `info.json.recentEvents` (ts 1778570278398, ~12:37 local) is in theory eligible. Whether `scheduleHybridEnrichment` actually fired for it cannot be determined from the runtime event journal alone (Finding 2). Would need to grep the daemon's stdout / log file from that time window to check for `log.info("hybrid_llm enrichment ...")` lines. Not blocked, just out of in-conversation scope.

## Why this matters

Rev1 already noted that rebind-class observed values get a narrowed KIND_CHAIN (only `narrative` + `replay-tail`, no `low-cost-server` / `llm-agent`). Combined with rev2:

- Rebind-class compaction tries only narrative (rev1) → narrative is deterministic concat (no actual size reduction beyond tool-stub redaction) → context fills again quickly → next narrative compaction stacks atop the prior anchor → anchor grows linearly → no LLM-driven distillation fires because eligibility excludes rebind-class
- The stacking continues until a non-rebind trigger (overflow / cache-aware / manual) eventually fires, AT WHICH POINT enrichment becomes possible but operates silently

The "rare observation" of hybrid_llm enrichment has two layered causes:
1. **Most paths never reach the eligibility check** (rev1's KIND_CHAIN narrowing + the explicit `Set<Observed>` exclusion here)
2. **The remaining paths emit no telemetry**, so even when enrichment fires, it's invisible

## Proposed fix (two-line + telemetry)

### Part A — expand eligibility

```ts
// compaction.ts:2159
const hybridEnrichmentEligible: ReadonlySet<Observed> = new Set([
  "overflow",
  "cache-aware",
  "manual",
  "rebind",                    // NEW
  "continuation-invalidated",  // NEW
  "provider-switched",         // NEW
  "stall-recovery",            // NEW (sibling of cache-aware)
])
```

Leave `idle` and `empty-response` out of the eligible set:
- `idle` is by definition "no pressure"; spending LLM tokens on a non-pressured anchor is waste
- `empty-response` already uses `low-cost-server` as first attempt (better choice than hybrid_llm follow-on)

### Part B — add telemetry

In `scheduleHybridEnrichment` (compaction.ts:1607), emit at each lifecycle step:

```ts
RuntimeEventService.append({ domain: "telemetry", eventType: "session.hybrid_enrichment.scheduled", ... })
RuntimeEventService.append({ domain: "telemetry", eventType: "session.hybrid_enrichment.skipped",    ... })
RuntimeEventService.append({ domain: "telemetry", eventType: "session.hybrid_enrichment.started",   ... })
RuntimeEventService.append({ domain: "telemetry", eventType: "session.hybrid_enrichment.succeeded", ... })  // body delta, before/after token estimates
RuntimeEventService.append({ domain: "telemetry", eventType: "session.hybrid_enrichment.failed",    ... })  // error msg
```

Without these, the user's question "why don't I see it happen?" has no answer in the available observability surface — exactly the data-plane-vs-control-plane lesson from DD-14.

## Scope note

Same boundary as rev1: this lives in compaction spec territory, not in session/rebind-procedure-revision. The observation is recorded here because the chain-init protocol's telemetry made the gap visible. The fix is one or two lines in compaction.ts + a small telemetry surface; can be done as a hotfix or rolled into a sibling spec `compaction/rebind-class-enrichment-extension`.

## Status

- [ ] Observation recorded (this event)
- [ ] daemon stdout log audited for "hybrid_llm enrichment" lines (verifies finding 3)
- [ ] User decision: one-line eligibility expansion now? or full sibling spec cycle?
- [ ] Telemetry surface design (Part B above) — needs spec because new event types affect dashboard contract
