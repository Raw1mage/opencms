# Design: compaction-fix

Decisions for the four shipped components: three itemCount-gated
triggers, the anchor-prefix expansion (Phase 2), and the
compaction-priority simplification.

## Context

gpt-5.5's 272 K hard-cap context window exposes a codex backend
input-array sensitivity at ~250+ items. Pre-existing token-based
compaction (~88% threshold) doesn't fire in time because itemCount
can climb on small-tool-call sessions while tokens stay low.

## Decisions

### DD-1: Trigger threshold

`PARALYSIS_ITEMCOUNT_COMPACT_THRESHOLD = 250`. Used by all three
itemCount-gated triggers. 50–100 buffer below the empirical 300+
failure region (RCA in
[fix-empty-response-rca/](../fix-empty-response-rca/)).

Token-side companion threshold: rebind-time pre-emptive uses
`tokenRatio > 0.7`.

### DD-2: itemCount estimation

Walk `MessageV2.WithParts[]` count one item per:
- user message
- assistant message with non-empty text part
- each ToolPart (function_call)
- each ToolPart with `state.status ∈ {completed, error}`
  (function_call_output)

Mirrors the codex provider's `convertPrompt` emission shape so
runtime estimate matches the actual `[CODEX-WS] REQ inputItems` log.

Same algorithm used by:
- Three runloop triggers (paralysis × bloated-input,
  ws-truncation × bloated-input, pre-emptive rebind)
- UI telemetry tooltip (Q card "N items" line)

### DD-3: Paralysis × bloated-input trigger

[prompt.ts](../../packages/opencode/src/session/prompt.ts), at the
3-turn paralysis-detector recovery branch. When sigTriple OR
narrativeTriple matches AND `paralysisRecoveryCount === 0` AND
itemCount > 250 AND not a subagent:
- Run `SessionCompaction.run({observed: "overflow"})` instead of
  injecting the recovery nudge
- Set `paralysisRecoveryCount = 1` so we don't re-fire on the same
  episode
- On compaction failure, fall through to the existing nudge path

### DD-4: ws-truncation × bloated-input trigger

[prompt.ts](../../packages/opencode/src/session/prompt.ts), at
runloop iteration top after `lastFinished` is computed. When
`lastFinished.finish ∈ {unknown, error, other}` (the empty-turn
classifier's mapped finishReasons per
[sse.ts:357-367](../../packages/opencode-codex-provider/src/sse.ts#L357-L367))
AND itemCount > 250 AND not a subagent:
- Run `SessionCompaction.run({observed: "empty-response"})`
- Single-shot: do NOT wait for a streak

Loop avoidance: after compaction writes a new anchor, the next
iteration's `lastFinished` resolves to the anchor (`finish: "stop"`,
no classifier-failure mapping), so the trigger doesn't re-fire.

The empty-turn classifier metadata is captured at runtime in
processor.ts but NOT persisted onto any part schema — the
message-level `finish` field is used instead because it IS persisted.

### DD-5: Pre-emptive rebind compaction

[prompt.ts](../../packages/opencode/src/session/prompt.ts), at
step=1 immediately after `applyStreamAnchorRebind` slicing. After
the anchor scan + slice:
- Estimate itemCount from sliced msgs
- Read `lastFinished.tokens.total / model.limit.context = tokenRatio`
- If `itemCount > 250 OR tokenRatio > 0.7` →
  `SessionCompaction.run({observed: "rebind"})` → `continue`
- On compaction failure, fall through to the live request (the
  reactive ws-truncation × bloated-input trigger still catches)

Daemon restart resets `state.lastResponseId` for every session, so
the first request after restart MUST send the full input array.
Pre-emptive compaction at this exact moment caps the burn that
would otherwise come from sending a bloated full-input on a fresh
chain.

Healthy / freshly-anchored sessions skip naturally (items already
low after slice, tokens below threshold).

### DD-6: Phase 2 storage on CompactionPart metadata

Reuse the existing `CompactionPart` (no new part type). Extend its
optional `metadata` object additively with:

```ts
serverCompactedItems?: unknown[]   // raw codex Responses API ResponseItem[]
chainBinding?: { accountId: string; modelId: string; capturedAt: number }
```

Anchor message already exists and carries the summary; bolting Phase
2 onto its metadata avoids schema churn and keeps the L2 anchor-as-a-
record invariant intact. `unknown[]` because items are codex-format
ResponseItems whose schema lives in `@opencode-ai/codex-provider`
types — opaque to opencode core.

### DD-7: Chain identity binding

`compactedItems` are valid for projection only when:
- `chainBinding.accountId === current execution accountId`, AND
- `chainBinding.modelId === current execution modelId`

Mismatch → strip compactedItems from the projection (do NOT delete
from storage), fall back to anchor summary text. Storage-side keep
retains forensics; runtime projection skips them.

Codex's compactedItems are produced by a specific (account, model)
pair and may carry chain-internal references. Account switch /
model switch / cross-chain rotation invalidate them.

### DD-8: Phase 2 read path

`expandAnchorCompactedPrefix(messages, executionContext)` runs
**after** `applyStreamAnchorRebind` and **before**
`MessageV2.toModelMessages`. If anchor (`messages[0]`) carries valid
compactedItems:

- Drop the original anchor message from the projection
- For each `compactedItems` entry of `type === "message"`, emit a
  synthetic user-role MessageV2 message containing the entry's text
  content
- For other item types (function_call, function_call_output,
  reasoning), serialize as JSON inside a single labeled wrapper user
  message
- Concatenate: `[...synthesizedFromCompacted, ...messages.slice(1)]`

Convert compactedItems into MessageV2 form so the existing
`toModelMessages → convertPrompt` pipeline serializes them naturally.

### DD-9: Compaction priority for codex

`resolveKindChain` always prepends `low-cost-server` to the head of
the kind chain when `providerId === "codex"`, regardless of context
ratio or subscription flag. Other kinds fall through if server-side
fails.

Subscription flag and ctxRatio are no longer consulted. Parameters
retained on the input shape for back-compat with existing call sites
that still pass them.

### DD-10: Layer purity carve-out for compactedItems

The `LAYER_PURITY_FORBIDDEN_KEYS` guard does NOT apply to
compactedItems content. It DOES apply to any text we synthesize
ourselves around compactedItems (e.g., wrapper labels we add).

compactedItems are codex-produced black-box artifacts. They may
contain chain-internal tokens that look like L4 keys but are L2 from
codex's frame of reference (codex's own prior-conversation
references). Forcing layer purity here would mean rejecting codex's
own work.

`chainBinding` metadata IS L4 (synthesized by us), but it lives in
part metadata — not in prompt text — so layer purity doesn't apply
at projection time.

### DD-11: Failure / invalidation modes

| Failure | Recovery | Log level |
|---|---|---|
| Plugin returns no compactedItems | summary-only path | info |
| chainBinding mismatch (account/model switch) | strip from projection, keep storage | warn |
| compactedItems contain unmappable types | serialize as JSON in single synthetic message | warn (one-shot per anchor) |
| compactedItems shape parse error | strip from projection, keep storage | error |
| Compaction trigger fires but compaction throws | fall through to original code path (nudge / live request) | warn |

Never block prompt assembly; always degrade gracefully.

### DD-12: Feature flags

| Tweak | Default | Purpose |
|---|---|---|
| `compaction_phase1_enabled` | `0` | Disabled per-turn transformer (kept for experimental re-enable; not part of production architecture) |
| `compaction_phase2_enabled` | `1` | Phase 2 anchor-prefix expansion (live) |

Phase 1 transformer code retained at
[packages/opencode/src/session/post-anchor-transform.ts](../../packages/opencode/src/session/post-anchor-transform.ts);
flag-on path runs but is not active in production.

## Critical Files

- [packages/opencode/src/session/prompt.ts](../../packages/opencode/src/session/prompt.ts)
  — three trigger sites (DD-3, DD-4, DD-5) + Phase 2 expander wiring
- [packages/opencode/src/session/anchor-prefix-expand.ts](../../packages/opencode/src/session/anchor-prefix-expand.ts)
  — Phase 2 read path (DD-8, DD-10, DD-11)
- [packages/opencode/src/session/compaction.ts](../../packages/opencode/src/session/compaction.ts)
  — `tryLowCostServer` writes compactedItems (DD-6, DD-7);
  `resolveKindChain` codex-first priority (DD-9);
  `publishCompactedAndResetChain` event publishing
- [packages/opencode/src/session/message-v2.ts](../../packages/opencode/src/session/message-v2.ts)
  — `CompactionPart.metadata.serverCompactedItems` /
  `chainBinding` fields (DD-6)
- [packages/opencode/src/config/tweaks.ts](../../packages/opencode/src/config/tweaks.ts)
  — feature flags (DD-12)
