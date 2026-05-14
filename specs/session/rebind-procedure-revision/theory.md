# Theory: session/rebind-procedure-revision

Distilled patterns from this work. The opencode-specific details are recorded in design.md / events/; this file captures the parts that should transfer to other systems and to a future paper.

## 0. Contribution Framing — Multi-Dimensional Rebind

**The central contribution of this work is a *multi-dimensional rebind mechanism* — a single classifier-driven protocol that handles every event along which an agent's operating context can change mid-session.**

Mainstream agent frameworks today operate under what we call the **one-account-one-agent assumption**:

- A session is bound to a single API account / credential
- No rotation mechanism: when the account's quota / rate-limit / token expires, the session degrades or fails
- No cross-provider switching: an agent committed to OpenAI cannot mid-session hand off to Anthropic
- No cross-model switching: same provider, same model, end-to-end
- Compaction (if it exists at all) is a single mode — usually "summarise the older turns" — with no taxonomy for *why* it fired or *what kind of summarisation* was applied
- Chain continuity (where the underlying API supports it, e.g. OpenAI Responses `previous_response_id`) either holds or breaks; there is no protocol for *announcing* the break to the model

This is the design surface of every well-known agent framework as of 2026-05. The "one-account-one-agent" assumption is so deeply embedded that breaking it tends to break the agent's reasoning — exactly the failure class this work surfaces and addresses.

opencode broke this assumption deliberately in pursuit of 24×7 agent operation, but did so axis-by-axis as separate features:

| Axis | opencode's pre-this-work feature |
|---|---|
| **Account axis** | admin-panel switch + auto-rotation orchestrator (quota / 429 / manual triggers) |
| **Provider axis** | SS (codex / copilot / openai) vs SL (anthropic / gemini / openrouter / vercel / gitlab / gmicloud / opencode) interchangeable per session |
| **Model axis** | mid-session model switch within same provider (e.g. gpt-5.5 ↔ gpt-5.4) |
| **Continuity axis** | `previous_response_id` (codex) chain identity; `lastResponseId` per-account-shard storage |
| **Compaction axis** | 5 distinct compaction kinds (narrative / cache-aware / stall-recovery / preemptive / server-side), each with different semantics |
| **Failure-recovery axis** | empty-response recovery; backend-failure forced re-send; WS reconnect; daemon restart resume; session fork |

Each axis was correct in isolation. The bug surfaced in their **combinatorial interaction** — specifically, the absence of a unified protocol that tells the AI when *any* of these dimensions changes. The跳針 read-loop on ses_1e56ed3f9ffebv4AaWOlcPLz20 (2026-05-12) was the empirical witness: an account-switch event invalidated the chain, but the AI received no notification, so it fell into a 23-minute compensatory re-verification loop, burning ~30× nominal quota for zero forward progress.

The contribution is therefore not a bug fix. It is the design and verification of a **single protocol layer that unifies all six axes into one typed classifier** — 19 `ContinuationEvent` kinds × 3 provider classes × 6 decision flags — through which every chain-affecting operation funnels, capturing commitment digest before invalidation and re-initialising the AI's context window via a once-after-chain-break fragment carrying the digest.

**Why this matters for the paper:** the multi-dimensional rebind framework is the abstraction that makes the other features (rotation, cross-provider, multi-model, compaction-taxonomy) safely composable. Without it, each axis works alone but their cross-product is a minefield of stale-anchor / lost-reasoning / repeated-mutation failures. The protocol is what turns a collection of orthogonal axes into a coherent multi-dimensional space the agent can navigate.

**Empirical signal of the contribution's load-bearing role:** post-protocol, token-burn rate dropped ≈300× during multi-dimensional events (see `events/event_2026-05-12_token-efficiency-outcome-300x-improvement.md`). The cost difference between "AI knows the rebind happened" and "AI does not know" is the difference between paying ~1KB for one notice vs paying N×30k tokens for a recovery loop.

### Dimensions table (paper-friendly)

| Dim | Axis name | Cardinality this spec handles |
|---|---|---|
| D1 | Account | 1..N accounts per session, switching via admin / rotation / quota |
| D2 | Provider | {SS, SL, Hybrid} × any registered providerId |
| D3 | Model | Same-family + cross-family transitions |
| D4 | Chain continuity | Continuous, server-invalidated, client-invalidated; with notice |
| D5 | Compaction kind | {narrative, cache_aware, stall_recovery, preemptive_daemon_restart, server_side} |
| D6 | Failure recovery | {empty_response, backend_failure_forced_resend, ws_reconnect, session_resume_after_daemon_restart, …} |

Total `ContinuationEvent` discriminator cardinality across all six axes: **19 kinds** — every combination that can plausibly fire is named, classified, and handled.

---

## 1. Abstraction Leak Across Package-Inheritance Boundary

**Statement.** When package B is built atop package A, an invariant that holds in A's world may silently fail in B's world if B introduces concepts that A never had — and the protocol in A assumed an environment without those concepts.

**This work as instance.**

| Layer | Invariant assumed | Concept introduced downstream | Result |
|---|---|---|---|
| upstream codex CLI (`refs/codex/`) | `previous_response_id` chain is monotonic; the only way to abandon it is fresh session | — | invariant holds in upstream |
| opencode (`packages/opencode/`) | inherits the invariant via `@opencode-ai/provider-codex` | account-rotation, admin-panel account-switch, daemon-restart, empty-response-recovery, compaction (5 distinct chain-breaking events) | invariant broken: chain id is cut mid-session, but no init-protocol counterpart |

**Generalisation.** When inheriting a protocol from a system that operates under stricter constraints, audit the invariants that depended on those constraints. Each invariant that no longer holds in the descendant either (a) needs an additional protocol step to restore the same end-state, or (b) needs explicit acceptance that the invariant is gone and the dependent behavior is downgraded.

**Detection heuristic.** "Did this codebase invent a verb that the upstream codebase doesn't have?" If yes, list every operation the upstream protocol assumes will happen only at endpoints (session start, session end) and check whether the new verb fires the operation mid-session. Any mid-session firing without a paired re-init is a candidate abstraction leak.

**This case's leak.** opencode invented five chain-breaking events. Each implemented chain *invalidation* (the destruction half of session reset) but none implemented chain *re-init* (the construction half). The AI got a fresh chain id but no first-turn framing — neither "you are starting fresh" nor "you are resuming, here is the digest of what's already done". Codex's training distribution doesn't contain that intermediate state, so model behaviour degraded into safety fallback (re-read, re-verify, occasionally re-execute).

## 2. Control Plane vs Data Plane Verification

**Statement.** Telemetry events ("control plane") and downstream effects ("data plane") are necessary-but-not-sufficient for each other. Any prompt-injection / message-mutation feature MUST verify both planes before declaration of done.

**This work as instance.** Phase A introduced `PendingInjectionStore.mark(...)` and emitted `chain.init.injected` telemetry. Phase B/C wired `Continuation.run` to call `mark`. Telemetry fired accurately for every dispatch — control plane looked perfect. But no caller of `PendingInjectionStore.consume(...)` existed in production. The prompt builder never read the marker. The AI's outbound prompt did not contain the `<chain_init_notice>` fragment. **Telemetry was lying** in the sense that it described an intent that never materialised.

Discovered only by cross-referencing `llm.prompt.telemetry`'s `blocks[].fragmentIds` list — the data-plane witness — against the chain.init.injected event count.

**Failure pattern.**
- Writer side: implemented, tested in isolation, emits telemetry.
- Reader side: not yet implemented (or implemented but never connected).
- Tests: pass at the writer-test layer because they assert "write happened", not "read observed".
- Production: looks healthy from any single-plane observation.

**Diagnostic rule.** For every event a system emits, you must be able to point at the line of code that reads it. If you can't, the receiver doesn't exist. The event is metadata about an intent; it does not constitute the action.

**Generalisation to other surfaces.**
- SSE / WebSocket / Bus features: writing `Bus.publish(X)` is not enough; verify a subscriber received.
- DB write features: verifying INSERT returned is not enough; verify the next read path returns the row.
- File-system features: verifying `fs.writeFile()` returned is not enough; verify the consumer observed the new mtime / content.
- Cache invalidation features: verifying the invalidate call ran is not enough; verify the next read missed.

## 3. Classifier-as-Single-Decision-Point

**Statement.** When N independent call sites locally decide the same shape of question (e.g. "should I invalidate the chain and what should I tell downstream?"), consolidating the decision into a single typed classifier function improves both correctness and evolvability — even if the resulting classifier looks like a coarse switch statement.

**This work as instance.** Pre-this-work, five `invalidateContinuationFamily` call sites each made local decisions:
- prompt.ts:460 (in-loop anchor swap)
- prompt.ts:1208 (pre-loop account switch)
- prompt.ts:1451 (empty-response recovery)
- compaction.ts:189 (post-compaction publish)
- compaction.ts:3622 (pre-LLM compaction scrub)

Each had a different surrounding code path; each emitted different telemetry; each had subtly different invariants. Adding a new chain-break trigger (model switch, daemon restart, backend failure) meant copying logic across files with cross-cutting drift.

**The refactor.** `classify(event: ContinuationEvent): ContinuationDecision`. The matrix is now a single declarative table covering 19 event kinds × 3 provider classes. Adding a new event = add one row to `SHAPE_BY_KIND`. Forgetting to handle a case = TypeScript exhaustiveness error at compile time.

**Generalisation.** Look for repeated `if-else` chains that branch on the same shape of question across modules. If they branch identically, the question is a classifier; if they branch slightly differently, the differences are the data that the classifier should encode. The pattern fails when the local context is too rich to encode in a typed event (e.g. needs raw access to state that isn't part of the event shape) — but in such cases the smell is usually that the event type is undermodeled.

**Cost.** A single classifier introduces a central file that every caller depends on. Worth it when:
- The decision is repeated ≥3 sites
- Drift between sites is the dominant maintenance burden
- The decision matrix has enough cells that a table is clearer than scattered conditionals

## 4. Stale-Anchor Steady-State vs Periodic Event

**Statement.** TTL-based dedup mechanisms assume the duplicate detections are *periodic* events. When the underlying signal is a *steady-state condition* that only changes upon an explicit reset, a fixed TTL becomes a periodic leak: the dedup correctly suppresses for the TTL window, then expires, then re-fires once per TTL window indefinitely.

**This work as instance.** The chain-break detection at prompt.ts:460 / prompt.ts:1208 compares the latest compaction anchor's identity vs the session's pinned identity. The anchor only updates when compaction fires. Between compactions, the (anchor_account ≠ pinned_account) divergence is a *constant* — it does not stop being true on its own. Every prompt build re-fires the detection.

First-draft dedup used 5-min TTL. Result: one re-fire every 5 minutes, 12 leaks per hour. Bumping to 1 hour reduced the leak rate but kept the architectural flaw. The clean fix is to reset dedup on the event that genuinely changes the anchor (compaction → new anchor created → next detection has a different prev → key changes → bypass naturally). The interim 1-hour TTL is good enough because realistic sessions don't last that long without compacting.

**Generalisation.** Before adding a TTL to a dedup mechanism, ask: what *event* would make the duplicate detection genuinely new? If the answer is "X happens", reset on X rather than on time. If the answer is "the same condition stops being true", the dedup is fighting the detection layer, not augmenting it; consider fixing the detection.

**Diagnostic.** Plot dedup hits over time. Periodic spikes at TTL intervals = steady-state condition disguised as event. Sporadic / event-correlated spikes = correctly modelled periodic event.

## 4.5 Compaction Sustainability Invariant (rev5, 2026-05-13)

**Statement.** For any session running on any provider/model under a multi-dimensional rebind protocol P, P is *sustainable* if and only if every compaction commit C satisfies:

```
  context_residual(C) / model.context_limit  ≤  W_rel
```

where `W_rel ∈ (0, 1)` is a global ratio threshold (default 0.5). When the bound is violated, P MUST synchronously invoke a contractive compaction kind (one that produces strict size reduction — `low-cost-server` or `llm-agent` in this work) until the bound is restored OR the contractive kind itself failed.

**Why ratio, not absolute tokens.** Absolute thresholds (e.g. "anchor ≤ 100K tokens") don't generalise across models: a 100K anchor at a 128K-context provider is 78% utilization (unsustainable), the same anchor at a 272K-context provider is 37% (fine), and at a hypothetical 1M-context provider is 10% (trivial). The relative formulation is the only one that admits a single universal theorem statement.

**Why this is necessary, not just nice-to-have.** Some compaction kinds operate by **deterministic concat-and-redact** (this work's `narrative` kind serialises post-anchor dialog rounds, replaces tool-call output bodies with stub references, and appends the result to the previous anchor body). Such kinds have compression ratio α ≈ 1: they fold tool outputs into stubs but otherwise preserve dialog text verbatim. Without an external contractive backstop, repeated invocations grow the anchor linearly with time, and the session reaches its context limit deterministically in finite time. The Sustainability Invariant is the mathematical statement that a protocol must escalate to α < 1 mechanisms before this happens.

**Connection to upstream design constraints.** The contractive backstop must run synchronously (in the runloop's foreground) to be load-bearing, because background-only fallbacks (best-effort enrichment, post-hoc cleanup) can lose the race against active conversation. This work places the backstop directly after each local-kind commit in the chain walk; if the watermark is violated, the runloop blocks until a contractive kind completes or all contractive kinds fail.

**Operational expression in this work.** Implementation lives at `packages/opencode/src/session/compaction.ts`:
- `measureSustainabilityWatermark(sessionID, model)` — pure read-only ratio computation
- `forceContractiveCompaction(...)` — synchronous escalator; tries `low-cost-server` (codex `/responses/compact`) first, falls back to `llm-agent`
- Telemetry: `compaction.sustainability.measured` / `.fired` / `.completed` / `.failed` runtime events

The check fires only after LOCAL kind commits (`narrative` / `replay-tail`), not after contractive kind commits — preventing recursion when the contractive kind itself fails to fully restore the bound.

**Theorem (informal).** A multi-dimensional rebind protocol P that maintains the Sustainability Invariant on every compaction commit is sustainable in the sense that, for any T > 0, |context(t)| ≤ W_rel × model.context_limit for all t ∈ [0, T] modulo the small overshoot window between a local-kind commit and the synchronous contractive escalation that follows it. The window is bounded by the contractive kind's latency, which in practice is the codex `/responses/compact` round-trip (~seconds) plus the llm-agent fallback's local LLM call (~tens of seconds).

**Open question.** If both contractive kinds fail on the same session (network outage, quota exhausted on the codex compact endpoint), the protocol can only emit a `compaction.sustainability.failed` anomaly event and accept degradation — there is no further fallback short of refusing to continue the session. Whether this degradation should be hard-fail or best-effort-continue is a policy decision the protocol delegates to operators via the anomaly stream.

## 5. Other patterns observed but not fully developed

- **"Sibling fragment" composition over "unified conditional fragment"** (DD-1). Two fragments that can co-occur with shared rendering helper compose better than one fragment with internal branches. Trade-off: more code paths to test vs each fragment's body stays focused.
- **"Once-after-event" cache policy as first-class enum value** rather than implicit via TTL hacks (FragmentPolicy.once_after_chain_break).
- **"Explicit registry with startup assertion"** over runtime duck-typing for invariant-bearing maps (DD-11). Forces every addition to declare its classification; silent misclassification becomes a CI failure, not a runtime drift.
- **"Capture before invalidate" ordering invariant** for data that must survive a destructive operation (DD-8). Trivial-looking, frequently violated when the destructive op is wrapped in async / promise chains.

## 6. Open theoretical question

The chain-init protocol works on the assumption that **the AI will read the notice and adjust behaviour**. Empirically the digest does seem to influence subsequent reasoning (post-fix sessions don't reproduce the 11-round read-loop). But the influence is statistical, not contractual — the AI can still ignore the notice. A fully contractual solution would require either:
- a hard dispatcher-level tool mask (Layer D, deferred), or
- a fine-tune / RL signal where models are explicitly trained on chain-init-notice patterns.

The signalling layer this spec built is necessary but not sufficient. Sufficiency requires either model evolution or harder enforcement. Worth flagging as a limit of this contribution.
