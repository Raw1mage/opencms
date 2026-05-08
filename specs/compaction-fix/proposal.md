# Proposal: compaction-fix

## Status

Living. Merged to `main` 2026-05-09 (commit `01aca5124`). Iteration
history in
[docs/events/event_20260509_gpt55_itemcount_truncation_rca.md](../../docs/events/event_20260509_gpt55_itemcount_truncation_rca.md).

## Why

gpt-5.5 (released early May 2026) hard-caps `max_context_window` at
272 K, vs. 1 M on gpt-5.4 / 5.3. The codex backend tightens
input-array processing at the new ceiling: requests with high
inputItemCount (250+) hit ws_truncation @ frames=3 or
server_failed @ frames=1 even when total tokens are well under the
limit.

Pre-existing token-based compaction (~88% threshold) does not fire
in time because itemCount can climb high while tokens stay low —
many small tool calls each contribute one input item per call plus
one per output.

## What This Plan Does

Adds three runloop-level compaction triggers gated by itemCount, and
finishes the AI-based compaction integration that was incomplete
(codex `compactedItems` were dropped on the floor before this).

### Triggers

All gated by **itemCount > 250** (50–100 buffer below the empirical
300+ failure region).

| Trigger | Site | Signal |
|---|---|---|
| **Paralysis × bloated-input** | runloop, before nudge injection | 3-turn paralysis triple + itemCount > 250 |
| **ws-truncation × bloated-input** | runloop top, after `lastFinished` computed | `lastFinished.finish ∈ {unknown, error, other}` + itemCount > 250 |
| **Pre-emptive rebind** | step=1, after `applyStreamAnchorRebind` slice | itemCount > 250 OR token ratio > 0.7 |

All three call `SessionCompaction.run({observed: ...})` which writes
a fresh anchor; the next runloop iteration's slice is bounded.

### Anchor-prefix expansion (Phase 2)

When `tryLowCostServer` invokes codex `/responses/compact`,
structured `compactedItems` are persisted onto the anchor's
`CompactionPart.metadata.serverCompactedItems` plus `chainBinding`
(account/model identity). At prompt assembly,
`expandAnchorCompactedPrefix` validates chain binding and replaces
the anchor's free-form summary with codex-issued structured items
as synthetic user-role messages. Mismatched chain → fall back to
free-form summary.

### Compaction priority

Codex provider always tries `low-cost-server` first regardless of
context ratio or subscription flag (codex subscription doesn't bill
server-side compaction). Other providers retain local-first base
order. The earlier `codexServerPriorityRatio` and `isSubscription`
parameters are no longer consulted.

## Layer Separation

| Layer | Responsibility | Scope |
|---|---|---|
| **L1 Static prompt injection** | role / identity / tools / AGENTS.md / driver | Untouched |
| **L2 Conversation compaction** | Working memory: context summarization + addressable references | This plan |
| **L3 Lazy retrieval runtime** | Pull mechanism: storage → original content via reference | `system-manager:recall_toolcall_*` MCP tools |
| **L4 Session maintenance** | Connection state: chain ID, WS session, rotation, rebind | `transport-ws.ts` + `continuation.ts` |

### Layer Purity Invariant

Compaction payload is L2 working memory, not L4 connection state.

1. Trace markers and compactedItems do not embed accountId, providerId,
   WS session ID, `previous_response_id`, `conversation_id`, or
   connection-scoped credentials
2. WorkingCache reference IDs are sessionID-scoped, not bound to
   account/provider
3. Codex-returned compactedItems carrying chain-specific identifiers
   are resolved at the L2/L4 boundary (chainBinding metadata captured
   on storage, validated at projection)
4. Any read path (post-rotation, post-rebind, post-WS-reconnect)
   produces semantically equivalent prompts

## Out

- Storage schema structural changes (additive metadata only on
  `CompactionPart`)
- Codex provider `convertPrompt` chunking rules (matches upstream)
- WorkingCache core API
- Image base64 re-send (orthogonal)
- Reasoning encrypted_content lifecycle (orthogonal)

## Non-Goals

- Bit-exact alignment with upstream codex-rs
- Eliminating gpt-5.5 backend item-array sensitivity (upstream bug)
