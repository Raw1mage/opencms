---
date: 2026-06-09
summary: "Behavioural teardown of the 2.1.169 beta-assembly pipeline + new server-side-fallback/credit system; found opus-4-8 mid_conversation_system divergence"
---

# Teardown: beta-assembly pipeline + server-side fallback (2.1.169)

## Why

The fingerprint sync (VERSION + axios UA) is string-presence only and can't tell
whether the *betas-assembly logic* still matches what opencode replicates. Did a
full static teardown of the 2.1.169 native binary's beta pipeline and the new
fallback betas, independent of any code-alignment decision.

## New artifact

`chapters/betas-and-fallback-teardown-2.1.169.md` — decodes the 4-stage pipeline
(`tj`/`DA_`/`PGK` registration → `WW6` base builder → `QU`/`ZW6` per-platform →
`cH` per-request adds → `GW6` egress filter → `IW` projection), with verified
predicate meanings (`PW6`, `SN`, `hq`, `bW`, `iX$`, `O98`) and the resolved beta
set for opencode's primary opus-4-8[1m] OAuth config.

## Key findings

1. **DIVERGENCE (opus-4-8): `mid-conversation-system-2026-04-07`.** Gate `O98`
   returns `true` specifically for `claude-opus-4-8` (every other current model →
   false). The official CLI sends this beta on all opus-4-8 requests; opencode's
   `assembleBetas` has no `mid_conversation_system` step. Real `anthropic-beta`
   fingerprint gap on our most-used model. Recommendation recorded (gated push
   behind first-party/OAuth + opus-4-8); deferred as a parity change pending a
   live opus-4-8 capture — not auto-applied.

2. **New fallback system is config-gated, correctly skipped.**
   `server-side-fallback-2026-06-01` (`Yb4`, gated on `serverRefusalFallback` +
   adds a `fallbacks:[{model}]` body field) and `fallback-credit-2026-06-09`
   (`wb4`, gated on an armed credit lane / `fallbackCreditCode`). Server issues a
   `fallback_credit_token` (≤2048 chars) + a new `anthropic-ratelimit-unified-*`
   response-header family; token errors `credit_malformed`/`credit_wrong_org`/
   `credit_expired`/`credit_invalid_model`. opencode never arms these, so it
   emits neither beta nor the body field. Documented for a future overage feature.

3. **The other 3 new-in-2.1.169 registry betas stay gated:**
   `thinking_token_count` (statsig `tengu_chert_bezel`, default false),
   `narration_summaries` (`DW6()`), confirmed off on the normal path.
   `structured_outputs` (statsig `tengu_tool_pear`) also default false.

4. **Unchanged for our path:** request body fields, SSE event types, and request
   headers all match the existing datasheet; 2.1.169's new headers are all
   response-side.

## Code impact

None this round (teardown + documentation only, per user direction). The
opus-4-8 `mid_conversation_system` parity change is a tracked follow-up candidate
in the new chapter §5.

## Cross-refs

- `chapters/protocol-datasheets.md` §4.1 (cross-linked)
- `event_2026-06-09_sync-provider-claude-to-cli-2.1.169.md` (the fingerprint bump)
- refactor-anthropic skill §2 (beta flags)
