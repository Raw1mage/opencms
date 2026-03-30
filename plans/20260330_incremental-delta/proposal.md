# Proposal

## Why

- Codex incremental delta is conceptually supported by the upstream continuation protocol, but current OpenCode runtime still pays huge local context and streaming fanout costs.
- RCA showed the system preserves delta only at the provider request boundary, then re-expands into full-part persistence, full-event SSE fanout, and full consumer reconcile.

## Original Requirement Wording (Baseline)

- "這些分析成果不要浪費，開一個plan來記錄，delta fix plan"

## Requirement Revision History

- 2026-03-30: Started from RCA-only investigation of Codex incremental delta context blow-up.
- 2026-03-30: Refined into a fix plan focused on end-to-end delta preservation across request, runtime transport, and consumers.
- 2026-03-30: Expanded the same plan to include continuation failure handling (`first-frame timeout`, `mid-stream stall timeout`, `previous_response_not_found`) because append-only delta cannot be made safe without explicit invalidation and rebind rules.

## Effective Requirement Description

1. Preserve the validated RCA as an executable plan package.
2. Design a fix that makes incremental delta effective beyond the provider boundary.
3. Ensure request, SSE, Web, TUI, and subagent bridge paths are all represented in scope.
4. Treat the end goal as **zero replay, not zero history**: keep full local durable history, but avoid replaying prior context, tool results, and system prompt to the provider once a valid continuation contract exists.
5. Treat timeout, close-before-completion, and `previous_response_not_found` as part of the same continuation contract problem rather than a separate side issue.

## Scope

### IN

- Codex continuation protocol integration points
- Conversation versioning / invalidation rules for system prompt, tool schema, provider-model identity, and upstream state handles
- Continuation failure handling for websocket timeout/close ambiguity and HTTP `previous_response_not_found`
- Runtime part-update event contract
- SSE fanout payload strategy
- Web/TUI delta application behavior
- Subagent bridge amplification handling
- Instrumentation and validation strategy for the delta fix

### OUT

- Provider endpoint changes or upstream protocol redesign
- General product-wide compaction work
- Unrelated CPU, quota, or retry-loop fixes

## Non-Goals

- Solving every source of large-context cost in the product
- Replacing the entire message model or storage layer in one pass
- Hiding incompatibilities behind silent fallback behavior

## Constraints

- Must respect the existing Codex continuation protocol rather than inventing a new one.
- Must obey project policy: no silent fallback, fail fast on contract mismatch.
- Must preserve user-visible streamed output correctness in Web, TUI, and subagent views.
- Must separate durable transcript retention from hot-path transport shape.

## What Changes

- Add explicit instrumentation for request-side and output-side delta effectiveness.
- Add explicit continuation invalidation/version-control rules so append-only submission remains correct when system prompt, tools, model/provider, or upstream state changes.
- Add explicit continuation invalidation behavior for `first-frame timeout`, `mid-stream stall timeout`, close-before-completion, and `previous_response_not_found` so fallback/retry never silently inherits stale state.
- Redesign the session update path so streamed text does not repeatedly travel as full accumulated payloads.
- Update SSE and consumer logic to understand and apply append-only delta semantics.
- Align stale-delta protections with the actual hot path instead of legacy event assumptions.

## Why Prior Planning Likely Missed This

- Prior Codex planning appears to have treated provider-side continuation wiring as the main problem and implicitly assumed that request-trim success would carry the optimization through the rest of the runtime.
- The current RCA shows that assumption is false because OpenCode still conflates durable storage shape with streaming transport shape.
- Prior planning also appears to have under-modeled the Bus -> SSE -> Web/TUI/subagent cascade, so the dominant downstream amplification path was not made first-class in scope.

## Capabilities

### New Capabilities

- Delta-effectiveness observability: operators can measure whether delta savings survive past the provider boundary.
- Delta-aware streamed rendering: clients can append streamed assistant text without full-part reconcile on every chunk.
- Continuation failure recovery: operators can distinguish append-only continuation from explicit rebind/full-context reset boundaries.

### Modified Capabilities

- Codex continuation: still uses upstream continuation handles, but no longer loses the benefit inside local runtime fanout.
- Assistant streaming sync: Web, TUI, and subagent activity surfaces consume a delta-aware contract instead of relying on repeated full snapshots.

## Impact

- Affected runtime modules: session processing, message events, server SSE, app global sync, TUI sync, and subagent bridge.
- Affected docs: this plan package plus the existing RCA event log.
- Affected operators: developers gain clear metrics for where delta savings are lost.

## Planning Lessons

- Provider-side continuation wiring is necessary but not sufficient.
- Any future Codex or continuation-oriented plan must explicitly model three separate layers: request continuation, runtime transport, and consumer application.
- Plans in this area must also include explicit invalidation/version-control rules; otherwise implementation tends to stay conservative and replay-shaped.
