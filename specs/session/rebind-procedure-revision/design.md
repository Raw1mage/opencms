# Design: session/rebind-procedure-revision

## Context

The "rebind" surface in opencode evolved organically: `session.rebind` started as a UI-refresh signal (admin panel switches account → tell the UI to redraw), and over time absorbed unrelated concerns — codex `previous_response_id` invalidation, capability-layer reloads, daemon-restart pre-emptive compaction, empty-response chain reset. Each concern was patched into the existing event stream without a unifying contract. The result is five `invalidateContinuationFamily` call sites (with different surrounding logic at each), one rebind-epoch bump mechanism, one fragment-cache policy (`session_stable`) whose name predates the existence of chain-breaking events, and zero shared abstraction for "tell the AI a chain reset just happened."

Live failure (2026-05-12, session `ses_1e56ed3f9ffebv4AaWOlcPLz20`): rebind at 15:52 triggered `invalidateContinuationFamily`, dropped lastResponseId, bumped rebind epoch, fired SSE — and silently re-issued the next outbound prompt with no marker that the chain had changed. The AI received an apparent round-241 continuation, fell into a 23-minute read-loop (跳針), and the existing Layer C paralysis nudge could only react after the loop crystallised — never prevent it.

Sibling spec `compaction/recall-affordance` (graduated 2026-05-11) added the recall machinery (L1 TOOL_INDEX in anchor + L2 always-present recall tool + L3 amnesia-notice fragment) but explicitly scoped L3 to compaction kinds only, citing "codex's previous_response_id chain makes the notice unnecessary there" — exactly the assumption that rebind invalidates. This plan generalises that protocol across the full continuation-event surface.

## Goals / Non-Goals

### Goals
- Single classifier dispatches every chain-affecting event (12 kinds enumerated; provider-class aware)
- AI receives a structured notice on every must-break event, carrying commitment digest + recovery affordances
- `session_stable` cache policy split so chain-stable fragments invalidate correctly on chain reset
- All five existing `invalidateContinuationFamily` call sites rewired through the new executor
- Test coverage of every (event-kind, provider-class) cell in the classifier matrix

### Non-Goals
- Recovering lost server-side reasoning trace (structurally impossible)
- New paralysis layer (Layer D / dispatcher-level tool mask) — expected to drop in demand once chain-init works
- Subagent prompt overhaul (subagent has its own dedicated path)
- Chain-preserving retry for empty-response recovery (follow-up plan)
- Cross-provider reasoning-item format translation (follow-up plan if cross-provider switching becomes common)
- Capability-changed notice for E5 (follow-up sibling plan)
- Anthropic / Gemini chain-init equivalents (n/a — stateless providers have no chain)

## Architecture overview

The revised continuation procedure factors into four concerns, each with a dedicated module:

```
┌──────────────────────────────────────────────────────────────────┐
│  Event source layer (existing, lightly extended)                 │
│    rebind-epoch.ts, prompt.ts loop, compaction.ts, transport-ws  │
│    Emits typed ContinuationEvent { kind, providerClass, … }      │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Continuation classifier (NEW)                                   │
│    provider/chain-semantics.ts → providerClass(providerId)       │
│    session/continuation/continuation-event.ts → classify(evt)    │
│    Output: ContinuationDecision {                                │
│      breaksChain, capturesDigest, recomputesChainStable,         │
│      injectsChainInit, injectsAmnesia                            │
│    }                                                              │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Procedure executor (NEW; calls into existing primitives)        │
│    session/continuation/run.ts                                   │
│    Per decision flags:                                           │
│      1. capture commitment-digest (BEFORE invalidation)          │
│      2. call invalidateContinuationFamily if breaksChain         │
│      3. mark next outbound for chain-init injection              │
│      4. bump rebind epoch (for chain-stable fragment recompute)  │
│      5. emit telemetry                                            │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Fragment composition (extends existing context-fragments)       │
│    chain-init-notice.ts  (NEW, sibling of amnesia-notice)        │
│    amnesia-notice.ts     (EXTENDED — body includes digest)       │
│    commitment-digest.ts  (NEW, shared rendering helper)          │
│    Cache policy: chain_stable → recomputed on chain-init epoch   │
└──────────────────────────────────────────────────────────────────┘
```

Key inversion vs current code: today each `invalidateContinuationFamily` call site decides locally what to do, with no shared classifier. The classifier becomes the single decision point; every call site funnels through `Continuation.run(event)` which then dispatches.

### Architecture diagram (Mermaid)

```mermaid
flowchart TB
  subgraph EvSrc["Event source layer (existing, lightly extended)"]
    A1["rebind-epoch.ts"]
    A2["prompt.ts runloop"]
    A3["compaction.ts"]
    A4["transport-ws.ts (codex-provider)"]
    A5["server/routes/session.ts admin PATCH"]
  end
  EvSrc -->|ContinuationEvent { kind, providerId, … }| Run
  subgraph Run["Continuation.run (single dispatch executor)"]
    direction TB
    R0["dedup check<br/>(DispatchDedup, 1hr TTL)"]
    R1["classify(event)<br/>(SHAPE_BY_KIND × providerClass)"]
    R2["captureDigest<br/>(mutation-class, scrub, ≤1000 chars)"]
    R3["invalidateContinuationFamily<br/>(no-op for SL)"]
    R4["markPendingInjection<br/>(once_after_chain_break)"]
    R5["RebindEpoch.bumpEpoch<br/>(+ chainBreakClass payload)"]
    R6["emit chain.commitment.captured<br/>+ chain.init.injected/skipped"]
    R7["record dedup key"]
    R0 --> R1 --> R2 --> R3 --> R4 --> R5 --> R6 --> R7
  end
  R4 -.->|PendingInjectionStore| Consume
  R5 -.->|session.rebind event| SSE["SSE / dashboard subscribers"]
  subgraph Consume["Prompt builder (llm.ts) consumer"]
    direction TB
    C1["PendingInjectionStore.consume"]
    C2["decideAmnesiaInjection<br/>(recentEvents scan)"]
    C3["decideChainInitInjection<br/>(pending marker check)"]
    C4["buildAmnesiaNoticeFragment<br/>(extended with digest)"]
    C5["buildChainInitNoticeFragment"]
    C6["assembleBundles → bundle_user"]
    C1 --> C3
    C1 --> C2
    C2 --> C4
    C3 --> C5
    C4 --> C6
    C5 --> C6
  end
  C6 -->|input.messages| Codex["codex provider outbound"]
  Codex -.->|response| Loop["runloop next iteration"]
```

## Failure-Mode Taxonomy

Pre/post comparison along the chain-breakage failure class that this work addresses. Each row names the trigger, the observable failure mode before this spec landed, and the new observable behaviour.

| Trigger | Pre-this-work behaviour | Post-this-work behaviour | Verification source |
|---|---|---|---|
| `account_switch` (admin PATCH) | Chain invalidated silently; AI re-runs committed mutations; observed 11-round read-loop on ses_1e56ed3f9ffeb* | chain.init.injected fires with commitment digest; AI sees `<chain_init_notice>` in next outbound; no read-loop in 50+ round live observation | events/event_2026-05-12_live-verification-* |
| `account_rotate` (auto, quota / 429) | Same as above; rotation-heavy sessions saw orphan turns | Same as above; rotation governance unchanged but downstream framing now correct | inherits from above (same code path) |
| `provider_switch` (codex → anthropic etc.) | Chain invalidated; compaction triggered; AI's first turn on new provider had no context framing | Compaction's amnesia notice + chain_init_notice on first outbound; SL provider receives format-agnostic body | DD-3, sequence.json SEQ-2 |
| `model_switch` (gpt-5.5 ↔ gpt-5.4) | Untracked; codex's cross-model previous_response_id behaviour undefined | Conservative break + chain_init_notice (DD-4) | classifier unit tests |
| `compaction_narrative` / `cache_aware` / `stall_recovery` / `preemptive` | Recall-affordance L1+L2+L3 fired (existing 2026-05-11 work) | Same L1+L2+L3 + commitment digest now appended to L3 body via shared renderDigest | M5 amnesia-notice extension tests |
| `compaction_server_side` (codex /responses/compact) | Chain preserved; no notice (correct) | Unchanged; classifier returns skipReason="server_side_compaction" | classifier unit tests |
| `empty_response_recovery` (finish=unknown/other, 0 tokens) | invalidateContinuationFamily called as workaround; no AI framing | Continuation.run dispatches with kind=empty_response_recovery; AI sees notice | Phase B verification |
| `backend_failure_forced_resend` (finish=error, server_failed) | Uncovered by empty-response predicate; transport-ws scrubbed chain silently; AI re-attempted with no marker | Phase E added finish=error to predicate; dispatches with classifier="server_failed" | Phase E commit, classifier tests |
| `session_resume_after_daemon_restart` | lastResponseId wiped; pre-emptive compaction triggered; AI's first turn post-restart had no framing | Pre-emptive compaction unchanged + chain_init_notice on first outbound | event source layer extension |
| `capability_layer_refresh` (tools / AGENTS.md reload) | session.rebind emitted; no AI framing; tool catalog drift possible | Epoch bumps; chain_init suppressed (skipReason=capability_only); future capability_changed_notice deferred to F5 | DD-12 |
| `ws_reconnect` | No effect; chain id outlives socket | Unchanged; classifier short-circuits | classifier unit tests |
| `subagent_spawn` | Subagent had its own session, no parent contamination | Unchanged; classifier short-circuits with skipReason=subagent_spawn | DD-9 |
| `user_clear` (/clear) | Chain invalidated by intent; no notice (correct — user is aware) | Chain invalidated + skipReason=user_clear (DD-9, deliberate suppression) | classifier unit tests |
| `session_fork` | Child = fresh session; parent unaffected | Unchanged; classifier short-circuits with skipReason=no_prior_chain | classifier unit tests |

### Quota / token-efficiency outcome (unanticipated)

A side-effect surfaced during sustained live observation: **token-burn rate dropped by approximately two orders of magnitude** (~300×) relative to pre-fix 跳針 episodes. Detail in `events/event_2026-05-12_token-efficiency-outcome-300x-improvement.md`.

| Metric | Pre-fix (during 跳針) | Post-fix (normal work) |
|---|---|---|
| Wall-clock | 10 min | 60 min |
| Quota consumed | ~5 hours (≈30× nominal burn rate) | ~10% (≈0.1× nominal burn rate) |
| Tokens / minute | ~30k–50k (replay-driven) | ~1k–5k (incremental) |

**Mechanism**: chain-reset events forced full-prompt replay (no `previous_response_id`); at 270k context this means N rounds × ~30k tokens charged per loop. The chain_init_notice adds ~700 chars once per break, preventing the loop. Break-even is essentially the first prevented round.

### Post-graduation revision layer (rev1–rev5, 2026-05-12 → 2026-05-13)

Five revision events surfaced after the spec graduated; each addresses a structural assumption that didn't survive live observation. Recorded as `events/event_2026-05-1{2,3}_rev{N}-*.md`.

| rev | Symptom | Mechanism / change | Status |
|---|---|---|---|
| rev1 | rebind-driven compactions stayed `narrative`; never escalated even when context was large | Extended `KIND_CHAIN` for rebind / continuation-invalidated / provider-switched / stall-recovery to include `low-cost-server` + `llm-agent` as fallback positions | Code on main (commit `9c6d68b6f`); see [theory §1](theory.md#1-abstraction-leak-across-package-inheritance-boundary) for the underlying "rebind = small context" misclassification pattern |
| rev2 | Background `hybrid_llm` enrichment never observed; rebind-class excluded from eligibility + no telemetry | Extended `hybridEnrichmentEligible` set + added `session.hybrid_enrichment.scheduled` / `.skipped` runtime events | Code on main (commit `9c6d68b6f`); full lifecycle telemetry (`.started`/`.succeeded`/`.failed`) deferred to F14 |
| rev3 | Implementation of rev1 + rev2 (single commit, code applied) | (see above) | shipped |
| rev4 | Post-compaction `INJECT_CONTINUE[rebind]=false` suppressed Continue even for user-initiated rebind → AI silently stopped | Added PendingInjectionStore.peek override in `shouldInjectContinue`; chain-init pending mark is the distinguishing signal vs the 2026-04-27 phantom-rebind class | Code on main (commit `d0b47fe99`); cross-recorded in `compaction/user-msg-replay-unification` |
| rev5 | No long-horizon sustainability guarantee — anchors stack linearly under narrative-only commits, context fills monotonically | **Compaction Sustainability Invariant** (theory §4.5): synchronous ratio-based watermark backstop. After every local-kind commit, measure `context_residual / model.context_limit`; if > `W_rel` (default 0.5), synchronously invoke contractive kind (`low-cost-server` then `llm-agent`). Cross-model invariant by design. | Code on main (commit `e5c15e983`) |

The rev2/rev3/rev4 chain represents a structural pattern this work surfaced: **`rebind`-class observed values had been implicitly classified as "small / no-op" across multiple unrelated sets** (KIND_CHAIN, hybridEnrichmentEligible, INJECT_CONTINUE). Each set was correct under the assumptions of its day; rotation-heavy sessions falsified those assumptions simultaneously. Revs 1–4 are the structural fix for the misclassification; rev5 is the load-bearing sustainability invariant that turns "tell the AI about breaks" into "guarantee context stays bounded".

**Adjacent failure classes NOT addressed by this work** (tracked in `tasks.md` §M11.7):

| Failure class | Status | Where it lives |
|---|---|---|
| Subagent hung mid-tool-call | Not addressed | memory: project_subagent_hang_pattern.md; follow-up F9 |
| Tool catalog staleness | Not addressed | follow-up F10 |
| OAuth token expiry / quota depletion mid-session | Not addressed | follow-up F11 |
| Lost server-side reasoning trace | Structurally impossible to recover; this spec mitigates via commitment digest only | Non-goal per Goals/Non-Goals |
| AI ignores chain_init_notice and re-runs mutations anyway | Signalling layer is necessary but not sufficient | Follow-up F1/F2 (Layer D tool mask) and F6 (self-recover skill) |

## Decisions

- **DD-1**: Two fragments (sibling), not one. `chain_init_notice` and `amnesia_notice` stay separate fragments that share `commitment-digest.ts` rendering. Rationale: they encode orthogonal facts (server-side reasoning loss vs client-side message summarisation) which can co-occur (rebind during compaction round). One unified fragment would carry a conditional body that combinatorially branches; two fragments compose naturally. Resolves proposal Q1.
- **DD-2**: Commitment digest excludes READ-class tools. Only mutations (`apply_patch` / `edit` / `write` / `bash` with write effect / `move_file` / `delete_file`) get listed. Rationale: reads are cheap to redo; digest exists to prevent expensive re-mutation, not to recreate every prior thought. Resolves proposal Q2.
- **DD-3**: Notice body is provider-format-agnostic (user-role text fragment). Same body works for SS-leaving-to-SL or SL-arriving-to-SS. No translation layer needed. Resolves proposal Q3.
- **DD-4**: Same-family model switch (gpt-5.5 ↔ gpt-5.4) is treated as `breaksChain=true` by default. Rationale: codex's `previous_response_id` is documented as response-scoped, and reasoning traces are model-specific; cross-model reuse is at best server-undefined. Conservative breakage is safer than silent reasoning drift. May relax to `breaksChain=false` later if telemetry proves cross-model reuse works. Resolves proposal Q4.
- **DD-5**: Backend-failure forced re-send (E12, transport-ws.ts:561/571/581/607) is reclassified as a `breaksChain=true` event. Currently it cuts the chain but emits no chain-init notice — same gap as E1a/E8. Resolves proposal Q5.
- **DD-6**: Copilot is SS class. The `statelessReasoningIndex` in `convert-to-openai-responses-input.ts` is a fallback rendering format for when `previous_response_id` is absent (inline reasoning items), not a runtime mode toggle. Copilot uses `previous_response_id` whenever the SDK provides it. Resolves proposal Q6.
- **DD-7**: `session_stable` policy split is mandatory, not opt-in. Every existing consumer must be explicitly classified during the migration; ambiguous cases raise an error rather than defaulting silently (per AGENTS.md no-silent-fallback rule). One-time PR cost in exchange for invariant clarity.
- **DD-8**: Commitment digest capture is synchronous-before-invalidation. The procedure executor captures the digest into `session.execution.recentBreakDigest` field BEFORE calling `invalidateContinuationFamily`. If capture fails, invalidation still proceeds but the next chain-init notice carries `digestEntryCount: 0` and a sentinel marker `"<commitment_digest_unavailable>"`. This avoids the failure mode where invalidation succeeds, digest capture races against message-store mutation, and ends up empty.
- **DD-9**: Subagent spawn (E10) and user `/clear` (E11) explicitly suppress chain-init notice. Subagent has no prior chain to mourn (it's a true fresh start). User /clear is user-aware reset — re-prompting would be patronising. Both events flow through `Continuation.run` and the classifier returns `injectsChainInit: false`, so the dispatch is uniform.
- **DD-10**: Empty-response recovery (E8) keeps current invalidation behaviour AND adds chain-init notice. Chain-preserving retry is deferred to a follow-up plan; this plan's contribution is making sure the AI gets told.
- **DD-11**: Per-provider chain-semantics registry uses static typing (Zod enum), not duck-typing at runtime. Adding a new provider must explicitly declare its class. Rationale: stateless misclassification is a silent failure mode (no-op invalidation looks fine until you find a subtle continuity bug); explicit declaration catches it at PR time.
- **DD-12**: Capability-layer refresh (E5) suppresses chain-init notice but emits a future `capability_changed_notice` (out of scope for this plan; tracked as a follow-up). Chain id is preserved; only the tool/AGENTS.md fragments mutate. The AI does need to be told tools changed, but that's a different notice with different body.
- **DD-13**: **transport-ws.ts dispatch sites stay as primitive chain scrubs; semantic Continuation.run dispatch happens at the runloop level instead.** Original tasks.md M7-5 specified rewiring `packages/provider-codex/src/transport-ws.ts:319 / 435 / 751` and the `resetWsSession` helper at line 82 to use `Continuation.run`. On inspection that path created a reverse package dependency (codex-provider would import from session/continuation/). The architecturally correct dispatch point is at the runloop level where the transport's failure outcome surfaces — already in packages/opencode/. Phase E thus extended `prompt.ts` isEmptyRound predicate to include `finish === "error"` and dispatch through Continuation.run({ kind: "backend_failure_forced_resend" }) at the runloop, leaving transport-ws sites as primitive chain scrubs. Documented in commit `3cc9df530`.
- **DD-14**: **PendingInjectionStore consumer must be wired into the prompt builder BEFORE the spec can be declared functionally complete.** Phase A introduced the mark/consume API and the buildChainInitNoticeFragment helper, and Phase B/C wired Continuation.run to write the mark — but no caller of `PendingInjectionStore.consume` existed in production code. Result: chain.init.injected telemetry fired accurately at the control plane while the actual prompt body lacked the fragment. Discovered during the first live verification on ses_1e56ed3f9ffebv4AaWOlcPLz20 (account switch ~19:56, 2026-05-12). Closed by hotfix `a89fef9c9` (test branch) + `fccb2731b` (redundant beta branch, content-equivalent, force-deleted at cleanup). Formal rule: any prompt-injection-style feature MUST verify both control plane (event fired) AND data plane (fragment in bundle fragmentIds list) before declaring done.
- **DD-15**: **DispatchDedup TTL is 1 hour, not 5 minutes.** First-draft TTL of 5 minutes leaked one re-dispatch every 5 minutes indefinitely because stale-anchor divergence is a *persistent* condition — the compaction anchor only updates on compaction, so the (anchor.accountId vs execution.accountId) divergence is steady-state noise rather than a periodic event. Set TTL to 1 hour so realistic chat sessions stay deduped end-to-end. Genuine re-dispatch is still possible via either (a) compaction creating a new anchor with the post-switch accountId — next divergence detection has a different prev → different dedup key → bypass, or (b) user switching to a different account pair → different key. Initial 5-min draft committed as `b8df87855`; bumped to 1 hour in `a0807416a`.
- **DD-16**: **SkipReason "amnesia_supersedes" replaces fallback "unspecified" for compaction kinds.** The four compaction shapes (compaction_narrative / compaction_cache_aware / compaction_stall_recovery / compaction_preemptive_daemon_restart) set `injectsChainInit=false` and `injectsAmnesia=true`. Pre-polish they had no explicit `skipReason`, so the chain.init.skipped emitter fell back to `"unspecified"`. These events aren't suppressions — they delegate notification to amnesia_notice. Adding the `"amnesia_supersedes"` SkipReason variant + setting it on the four compaction shapes lets dashboards distinguish genuine skips (user_clear, subagent_spawn, sl_provider, no_prior_chain, capability_only, ws_reconnect) from delegation to a sibling fragment. Commit `670c44046`.
- **DD-17**: **M6-5 (fragment cache-key inclusion via rebind epoch) is resolved-by-composition; no explicit hash field needed.** The original M6-5 task envisioned adding `rebindEpoch` to the prompt cache fingerprint. On Phase D inspection the existing prompt-cache hash already includes `promptTelemetryBlocks`, and when chain_init_notice / amnesia_notice appear in `bundle_user` the block's `name` field changes (it lists `fragmentIds`), the bundle's chars/tokens change, and the codex backend cache misses naturally. The fragment composition mechanism does the cache-invalidation work without any explicit epoch field. M6-5 is closed as "resolved-by-composition"; documented in Phase D event note + commit `861f2a3a4` body.

## Code anchors

- packages/opencode/src/provider/chain-semantics.ts:1 (NEW) — `ProviderChainClass = "SS" | "SL" | "Hybrid"`; `classifyProvider(providerId): ProviderChainClass`
- packages/opencode/src/session/continuation/continuation-event.ts:1 (NEW) — `ContinuationEvent` discriminated union; `classify(event): ContinuationDecision`
- packages/opencode/src/session/continuation/run.ts:1 (NEW) — `Continuation.run(event)` procedure executor
- packages/opencode/src/session/continuation/commitment-digest.ts:1 (NEW) — `captureDigest(sessionID)`, `renderDigest(entries)`
- packages/opencode/src/session/context-fragments/chain-init-notice.ts:1 (NEW) — `decideChainInitInjection`, `buildChainInitNoticeFragment`
- packages/opencode/src/session/context-fragments/amnesia-notice.ts:50 (EXTEND) — `decideAmnesiaInjection` unchanged; `buildAmnesiaNoticeFragment` body extended to embed digest via shared helper
- packages/opencode/src/session/context-fragments/index.ts:* (REFACTOR) — fragment registry policy enum gains `chain_stable`; consumers re-tagged
- packages/opencode/src/session/prompt.ts:460-461 (REFACTOR) — replace direct `invalidateContinuationFamily` with `Continuation.run({ kind: "account_switch", ... })`
- packages/opencode/src/session/prompt.ts:1208-1209 (REFACTOR) — same, pre-loop site
- packages/opencode/src/session/prompt.ts:1451-1452 (REFACTOR) — same, empty-response site
- packages/opencode/src/session/compaction.ts:188-189 (REFACTOR) — same, compaction site
- packages/opencode/src/session/compaction.ts:3621-3622 (REFACTOR) — same, second compaction site
- packages/opencode/src/session/rebind-epoch.ts:194 (EXTEND) — `session.rebind` event payload gains `chainBreakClass`
- packages/opencode/src/provider/sdk/copilot/responses/openai-responses-language-model.ts:285 (REFERENCE) — confirms SS classification for copilot (DD-6)
- `packages/opencode/src/provider/chain-semantics.ts` — `classifyProvider` — SS/SL/Hybrid registry; throws ProviderChainSemanticsMissingError for unregistered providerId (DD-11)
- `packages/opencode/src/session/continuation/continuation-event.ts` — `classify` — 19-kind discriminated union + matrix classifier producing ContinuationDecision; SHAPE_BY_KIND drives shapes per kind, SL/SS overlay applied at classify()
- `packages/opencode/src/session/continuation/commitment-digest.ts` — `captureDigest` — Captures last-N mutation-class tool calls before invalidation (DD-8 ordering invariant); secret scrubbing + truncation budgets
- `packages/opencode/src/session/continuation/pending-injection.ts` — `PendingInjectionStore` — In-memory once-after-chain-break marker; mark/peek/consume/clear API; consumed by llm.ts prompt builder
- `packages/opencode/src/session/continuation/run.ts` — `Continuation.run` — Single dispatch executor; 6 steps: dedup-check → classify → captureDigest → invalidateContinuationFamily → markPendingInjection → bumpEpoch → telemetry → record-dedup
- `packages/opencode/src/session/continuation/dispatch-dedup.ts` — `DispatchDedup` — Per-session stale-anchor dedup; 1hr TTL (DD-15); recurring kinds only (account_*/provider_*/model_*), one-shot kinds bypass
- `packages/opencode/src/session/context-fragments/chain-init-notice.ts` — `buildChainInitNoticeFragment` — Once-after-chain-break fragment; body = chain-reset framing + reason + commitment digest + recall affordances; sentinel marker on null digest
- `packages/opencode/src/session/context-fragments/amnesia-notice.ts` — `buildAmnesiaNoticeFragment` — Extended (M5) to optionally embed CommitmentDigest at body tail; backward-compatible when caller omits digest
- `packages/opencode/src/session/context-fragments/policy.ts` — `FragmentPolicySchema` — Policy enum split: always_on / conversation_stable / chain_stable / once_after_chain_break + legacy decay/dynamic; rejects deprecated "session_stable"
- `packages/opencode/src/session/llm.ts:1059` — `PendingInjectionStore.consume + buildChainInitNoticeFragment` — Phase C+ hotfix consumer; closes data-plane gap so chain_init_notice actually reaches user-role bundle (DD-14)
- `packages/opencode/src/session/prompt.ts:1208` — `pre-loop account_switch dispatch` — Phase C rewire: detect prev/next account divergence → Continuation.run({ kind: "account_switch" }); subsumes prior RebindEpoch.bumpEpoch + invalidateContinuationFamily pair
- `packages/opencode/src/session/prompt.ts:460` — `deriveObservedCondition anchor-account divergence` — Phase C rewire: in-loop detection at compaction decision point; dispatches account_switch through Continuation.run
- `packages/opencode/src/session/prompt.ts:1499` — `empty-response / backend-failure dispatch branch` — Phase B (M7-1) + Phase E: finish ∈ {unknown, other} → empty_response_recovery; finish=error → backend_failure_forced_resend (classifier=server_failed)
- `packages/opencode/src/session/compaction.ts:182` — `publishCompactedAndResetChain` — Phase C rewire: maps (observed, kind) → compaction_* ContinuationEvent kind via mapCompactionEventMetaToKind; dispatches through Continuation.run
- `packages/opencode/src/session/rebind-epoch.ts` — `BumpEpochInput + ChainBreakClass` — Phase D extension: BumpEpochInput.chainBreakClass optional; appended to session.rebind event payload so dashboards can filter SS-break / SL-noop / capability-only / user-intent / preserved
- `packages/opencode/src/session/compaction.ts` — `measureSustainabilityWatermark` — rev5: pure ratio computation context_residual / model.context_limit; cross-model invariant (DD-15 + theory.md §4.5)
- `packages/opencode/src/session/compaction.ts` — `forceContractiveCompaction` — rev5: synchronous escalator; tries low-cost-server first (codex /responses/compact), llm-agent fallback; emits sustainability.{fired,completed,failed}
- `packages/opencode/src/config/tweaks.ts` — `CompactionConfig.sustainabilityRatio` — rev5: ratio threshold (default 0.5); model-agnostic via division by model.context_limit; configurable
- `packages/opencode/src/session/compaction.ts:2327` — `post-local-commit sustainability hook` — rev5: insertion point in run() — measures watermark after every isLocalKind commit, fires force-compact if violated
- `packages/opencode/src/session/compaction.ts:874` — `KIND_CHAIN rebind-class extension` — rev3 hotfix: rebind / continuation-invalidated / provider-switched / stall-recovery now include low-cost-server + llm-agent (was local-only)
- `packages/opencode/src/session/compaction.ts:2209` — `hybridEnrichmentEligible (extended)` — rev3 hotfix: rebind-class added to background hybrid_llm enrichment eligibility (was overflow/cache-aware/manual only)
- `packages/opencode/src/session/compaction.ts:2412` — `shouldInjectContinue chain-init-pending override` — rev4 amend (cross-spec compaction/user-msg-replay-unification): consults PendingInjectionStore.peek when INJECT_CONTINUE table-default is false, to distinguish user-initiated vs phantom rebind

## Interface contracts

### ContinuationEvent (discriminated union)

```ts
type ContinuationEvent =
  | { kind: "account_switch", sessionID, previousAccountId, accountId, providerId }
  | { kind: "account_rotate", sessionID, previousAccountId, accountId, providerId, trigger: "quota" | "429" | "manual" }
  | { kind: "provider_switch", sessionID, previousProviderId, providerId }
  | { kind: "model_switch_same_family", sessionID, previousModelId, modelId, providerId }
  | { kind: "model_switch_cross_family", sessionID, previousModelId, modelId, providerId }
  | { kind: "session_fork", sessionID, parentSessionID }
  | { kind: "session_resume_daemon_alive", sessionID }
  | { kind: "session_resume_after_daemon_restart", sessionID }
  | { kind: "capability_layer_refresh", sessionID, reason }
  | { kind: "compaction_narrative", sessionID, anchorId }
  | { kind: "compaction_cache_aware", sessionID, anchorId }
  | { kind: "compaction_stall_recovery", sessionID, anchorId }
  | { kind: "compaction_preemptive_daemon_restart", sessionID, anchorId }
  | { kind: "compaction_server_side", sessionID, anchorId }
  | { kind: "empty_response_recovery", sessionID, emptyRoundCount }
  | { kind: "ws_reconnect", sessionID }
  | { kind: "subagent_spawn", sessionID, parentSessionID }
  | { kind: "user_clear", sessionID }
  | { kind: "backend_failure_forced_resend", sessionID, classifier }
```

### ContinuationDecision

```ts
interface ContinuationDecision {
  breaksChain: boolean
  capturesDigest: boolean
  recomputesChainStable: boolean
  injectsChainInit: boolean
  injectsAmnesia: boolean
  bumpsRebindEpoch: boolean
}
```

### Classifier matrix (canonical, derived from proposal R4)

| Event kind | SS providerClass | SL providerClass |
|---|---|---|
| account_switch | breaks + digest + init + epoch | n/a — epoch only |
| account_rotate | breaks + digest + init + epoch | n/a — epoch only |
| provider_switch | (leaving SS) breaks + digest + init | (leaving SL) no-op for chain; epoch only |
| model_switch_same_family | breaks + digest + init (DD-4) | n/a |
| model_switch_cross_family | breaks + digest + init | n/a |
| session_fork | child: no prior chain → no init; parent: untouched | same |
| session_resume_daemon_alive | no break; epoch only | no break; epoch only |
| session_resume_after_daemon_restart | breaks (lastResponseId wiped) + digest + init + epoch | no break (stateless); pre-emptive compaction unchanged |
| capability_layer_refresh | no chain break; epoch only; future capability_changed_notice | same |
| compaction_narrative | breaks + digest + amnesia + epoch | breaks message-history + amnesia + epoch |
| compaction_cache_aware | same | same |
| compaction_stall_recovery | same | same |
| compaction_preemptive_daemon_restart | same | same |
| compaction_server_side | no client-visible break (existing skip rule) | n/a |
| empty_response_recovery | breaks + digest + init + epoch (DD-10) | rare; no-op |
| ws_reconnect | no break | no chain |
| subagent_spawn | child: fresh start, no init (DD-9) | same |
| user_clear | suppressed (DD-9) | same |
| backend_failure_forced_resend | breaks + digest + init (DD-5) | n/a |

### Continuation.run (procedure executor)

```ts
async function run(event: ContinuationEvent): Promise<ContinuationOutcome> {
  const decision = classify(event)
  
  // Step 1: capture digest BEFORE invalidation (DD-8)
  let digest: CommitmentDigest | null = null
  if (decision.capturesDigest) {
    digest = await captureDigest(event.sessionID).catch(() => null)
  }
  
  // Step 2: invalidate chain (no-op for SL providers)
  if (decision.breaksChain) {
    await invalidateContinuationFamily(event.sessionID)
  }
  
  // Step 3: mark next outbound for fragment injection
  if (decision.injectsChainInit || decision.injectsAmnesia) {
    await markPendingInjection(event.sessionID, {
      chainInit: decision.injectsChainInit,
      amnesia: decision.injectsAmnesia,
      digest,
      reason: event.kind,
    })
  }
  
  // Step 4: bump epoch (drives chain_stable fragment recompute)
  if (decision.bumpsRebindEpoch) {
    await RebindEpoch.bumpEpoch({ sessionID: event.sessionID, trigger: event.kind, ... })
  }
  
  // Step 5: telemetry
  await emitEvents(event, decision, digest)
  
  return { decision, digest }
}
```

### Fragment policy registry

```ts
type FragmentPolicy =
  | "always_on"             // recomputed every turn
  | "conversation_stable"   // computed at session creation; never recomputed (was "session_stable")
  | "chain_stable"          // recomputed on rebind epoch bump (NEW)
  | "once_after_chain_break" // injected on next outbound, then cleared
```

Migration: every existing `session_stable` consumer must be explicitly classified. Default during migration is `conversation_stable` only after explicit audit. Bundle_user retags `chain_stable`. Static system block stays `conversation_stable`.

## Sequence sketch — account-switch case

```
T0: user clicks "switch account" in admin panel
T1: server route fires Continuation.run({ kind: "account_switch", ... })
T2:   classify → { breaksChain, capturesDigest, injectsChainInit, bumpsRebindEpoch }
T3:   captureDigest scans last 50 messages, filters mutation tools, returns 0-5 entries
T4:   invalidateContinuationFamily(sessionID) clears lastResponseId on disk
T5:   markPendingInjection writes { chainInit: true, digest: [...], reason: "account_switch" }
T6:   bumpEpoch → emits session.rebind event with chainBreakClass: "SS-break"
T7: next user message arrives
T8: prompt builder runs:
T8a:   chain_stable fragments recompute (bundle_user picks up new AGENTS.md if account-scoped)
T8b:   pending injection consumed → chain-init-notice fragment built with digest
T8c:   outbound request: no previous_response_id, contains chain_init_notice in user role
T9: codex starts fresh chain; AI sees the notice; reasoning starts from "I just rebounded, here's what I had committed to"
```

## Migration / rollout

- **Phase A — additive**: add chain-semantics registry, continuation-event types, chain-init-notice fragment, commitment-digest helper. No existing call site rewired. Tests cover the new code in isolation.
- **Phase B — rewire one site**: convert the empty-response-recovery site (`prompt.ts:1451`) to `Continuation.run`. Smallest blast radius. Validate end-to-end against staged session reproducing 5/12 跳針.
- **Phase C — rewire remaining sites**: account switch, compaction × 2, second compaction path. Each gets a regression test.
- **Phase D — policy split**: introduce `chain_stable` policy enum value, retag bundle_user, audit every remaining `session_stable` consumer. This is the riskiest phase — every existing consumer is touched. Land in its own PR.
- **Phase E — backend-failure path (E12)**: rewire transport-ws.ts:561/571/581/607 sites into `Continuation.run({ kind: "backend_failure_forced_resend", ... })`. Lowest priority — already breaks chain today; just adds the notice.

Each phase is independently shippable; later phases pre-suppose nothing but the existence of the earlier modules.

## Telemetry contract

- `chain.init.injected` — payload: `{ sessionID, eventKind, digestEntryCount, bodyCharCount, reason }`
- `chain.init.skipped` — payload: `{ sessionID, eventKind, reason }` (e.g. `user_clear`, `subagent_spawn`)
- `chain.commitment.captured` — payload: `{ sessionID, sourceMessageCount, digestEntryCount, capturedAt }`
- `session.rebind` — extended payload: `{ ..., chainBreakClass: "SS-break" | "SL-noop" | "capability-only" | "user-intent" | "preserved" }`

## Tests required

Minimum 30 tests; matrix-driven:

- 1 test per filled cell in classifier matrix (~30+ cells, but many collapse to "no-op for SL")
- decideContinuationInjection happy path + suppression rules (subagent, user-clear)
- captureDigest: mutation-only filtering, N-entry truncation, scrubbing, capture-before-invalidation ordering invariant
- chain-init-notice fragment body: with digest / without digest / digest unavailable sentinel
- amnesia-notice extended body: with digest
- policy split migration: each existing session_stable consumer audited
- end-to-end regression: re-run live session reproducer (ses_1e56ed3f9ffebv4AaWOlcPLz20 fixture) and confirm no跳針

## Risks / Trade-offs

- **Risk R-1**: digest capture races against message-store mutation during compaction. Mitigation: capture before invalidation (DD-8); accept sentinel marker on failure.
- **Risk R-2**: chain-init notice fires too often and trains the model to ignore it. Mitigation: once-after-chain-break policy; never re-inject on same break.
- **Risk R-3**: policy split migration misclassifies a fragment, causing silent stale cache after chain break. Mitigation: explicit classification (DD-7); no silent defaults; CI test that asserts every fragment has an explicit policy.
- **Risk R-4**: SS classification wrong for a new provider added later. Mitigation: registry-driven (DD-11); CI test that asserts every registered provider has a class.
- **Risk R-5**: `Continuation.run` adds latency to chain-break path. Mitigation: digest capture is ≤50ms in benchmark; invalidation latency unchanged; epoch bump is in-memory; total overhead bounded.

### Trade-offs accepted
- **Cache-miss bump on chain reset**: `chain_stable` fragments recompute on every chain reset. This is roughly 10-15k tokens of bundle_user re-rendering per reset. Accepted because the alternative (stale cache silently dropping notices) is the failure mode we are fixing.
- **Two fragments instead of one (DD-1)**: chain-init + amnesia stay as siblings rather than a unified continuation-notice. Trade-off: slightly more code paths to test, but each fragment's body stays focused; co-occurrence (rebind during compaction) renders both naturally instead of via conditional body branches.
- **Conservative default for model switch (DD-4)**: same-family model switch defaults to chain break even though codex might tolerate cross-model `previous_response_id`. Trade-off: occasional unnecessary cache miss vs silent reasoning drift. Cache miss is recoverable; drift is not observable from telemetry.

## Critical Files

| File | Role | Touch |
|---|---|---|
| `packages/opencode/src/provider/chain-semantics.ts` | NEW provider-class registry | NEW |
| `packages/opencode/src/session/continuation/continuation-event.ts` | NEW event types + classifier | NEW |
| `packages/opencode/src/session/continuation/run.ts` | NEW procedure executor | NEW |
| `packages/opencode/src/session/continuation/commitment-digest.ts` | NEW capture + render helper | NEW |
| `packages/opencode/src/session/context-fragments/chain-init-notice.ts` | NEW fragment + decision helper | NEW |
| `packages/opencode/src/session/context-fragments/amnesia-notice.ts` | EXTEND — body embeds digest | EDIT |
| `packages/opencode/src/session/context-fragments/index.ts` | REFACTOR — policy split | EDIT |
| `packages/opencode/src/session/prompt.ts` | REWIRE 3 invalidate sites (lines 460, 1208, 1451) into Continuation.run | EDIT |
| `packages/opencode/src/session/compaction.ts` | REWIRE 2 invalidate sites (lines 189, 3622) into Continuation.run | EDIT |
| `packages/opencode/src/session/rebind-epoch.ts` | EXTEND — payload gains chainBreakClass | EDIT |
| `packages/opencode/src/session/transport-ws.ts` | REWIRE 4 backend-failure sites (lines 561/571/581/607) into Continuation.run | EDIT |
| `packages/opencode/src/provider/sdk/copilot/responses/openai-responses-language-model.ts` | REFERENCE only — confirms SS classification | NONE |

## Related specs

Explicit sibling references for KB graph traversal. wiki_query / wiki_graph use this list to surface neighbours on `fan-in:` / `fan-out:` queries.

**Predecessors (this spec extends or generalises them):**
- `compaction/recall-affordance` (living, 2026-05-11) — introduced L1 TOOL_INDEX-in-anchor + L2 always-present `recall` tool + L3 amnesia-notice fragment. This spec extends L3's trigger taxonomy from compaction-only to all chain-break events, and adds commitment digest to its body via the new shared `renderDigest` helper.

**Companions (this spec coordinates with them):**
- `compaction/empty-turn-recovery` — adjacent failure-class spec. The codex SSE→finishReason mapping documented there (`ws_truncation / ws_no_frames / unclassified → "unknown"`; `server_failed → "error"`; etc.) is the source of truth for Phase E's classifier mapping in `prompt.ts`.
- `compaction/itemcount-fix` — adjacent; gpt-5.5 itemCount triggers feed into `prompt.ts:1311+` `ws-truncation × bloated-input` single-shot compaction path, which now dispatches through `Continuation.run` (Phase C M7-4).

**Successors (deferred to follow-up plans):**
- `compaction/empty-response-chain-preserving-retry` (proposed) — replace E8 invalidation with chain-preserving retry; supersedes the current `empty_response_recovery` kind's break-and-notice semantic.
- `session/capability-changed-notice` (proposed, F5) — third sibling fragment for tool catalog / AGENTS.md mutation (E5); the chain-init protocol explicitly defers this case via `skipReason="capability_only"`.
- `session/cross-provider-reasoning-translation` (proposed, F3) — codex reasoning items → anthropic-compatible format for SS→SL provider switches.

**Theoretical kin (patterns surfaced; orthogonal to this spec):**
- `session/subagent-hang-pattern` (proposed, F9) — adjacent 24×7 stability gap; not chain-break but same `lastEventAt` watchdog architecture.
- memory `feedback_verify_control_and_data_planes.md` (2026-05-12) — feedback rule extracted from this spec's data-plane discovery (DD-14).

## Open follow-ups (out of scope here)

- `compaction/empty-response-chain-preserving-retry` — replace E8 invalidation with chain-preserving retry strategy
- `session/capability-changed-notice` — sibling fragment for E5 (tool catalog mutation)
- `session/cross-provider-reasoning-translation` — codex reasoning items → anthropic-compatible format (if cross-provider switching becomes common)

## Glossary

For readers approaching this spec without the full opencode mental model; also functions as the paper-supplement glossary.

- **Chain** — a server-side reasoning continuity identifier. In codex / OpenAI Responses API this is the `previous_response_id`. A chain accumulates the model's reasoning across turns; it is opaque to opencode (the content is server-held).
- **Chain identity** — the (provider, account, model) tuple that owns the current chain id. Changing any element invalidates the chain. opencode's "chain-breaking events" are the operations that change at least one element.
- **Anchor** — the most recent assistant message marked `summary: true`, written by compaction. Anchors record the (provider, model, account) state at write time and serve as the boundary between "pre-anchor messages (collapsed into prose)" and "post-anchor messages (intact)".
- **Stale-anchor divergence** — the condition where the anchor's identity differs from the session's current execution identity. Between compactions this divergence is a steady-state, not a periodic event (see theory.md §4).
- **Commitment digest** — a structured list of the last N (default 5) mutation-class tool calls performed before the chain broke. Used by both chain-init-notice and amnesia-notice fragments. Mutation-class = `apply_patch` / `edit` / `write` / `bash`-with-write-effect / `move_file` / `delete_file` (DD-2).
- **SS / SL / Hybrid provider classification** — Stateful (uses server chain id, e.g. codex, copilot, openai), Stateless (full-context resend, e.g. anthropic, gemini), Hybrid (mode-switchable). Static registry per DD-11.
- **ContinuationEvent** — typed discriminated union of all chain-affecting events. 19 variants enumerated. See data-schema.json.
- **ContinuationDecision** — output of `classify(event)`. Six booleans (`breaksChain`, `capturesDigest`, `recomputesChainStable`, `injectsChainInit`, `injectsAmnesia`, `bumpsRebindEpoch`) plus `chainBreakClass` and optional `skipReason`.
- **`chain_init_notice`** — user-role context fragment fired once after any must-break event. Body composes chain-reset framing + reason + commitment digest + recovery affordance hints. New in this spec.
- **`amnesia_notice`** — user-role context fragment fired while compaction is the latest break event. Body composes TOOL_INDEX hint + recall affordance + (post-this-spec) optional commitment digest. Predecessor from `compaction/recall-affordance`.
- **Once-after-chain-break policy** — fragment cache policy where the fragment is injected exactly once on the outbound following a chain-breaking event, then cleared. Implemented via `PendingInjectionStore.consume`.
- **Control plane vs data plane** — control plane = telemetry events ("we did X"); data plane = the actual prompt content that reached the model. See theory.md §2 for why both must be verified.
- **SkipReason** — categorical label for why `chain.init.skipped` fired instead of `chain.init.injected`. Values: `user_clear`, `subagent_spawn`, `no_prior_chain`, `capability_only`, `ws_reconnect`, `sl_provider`, `server_side_compaction`, `amnesia_supersedes`. Surfaced in runtime event payload so dashboards can filter genuine suppressions from delegation to sibling fragments.
- **chainBreakClass** — categorical label on the `session.rebind` event payload. Values: `SS-break`, `SL-noop`, `capability-only`, `user-intent`, `preserved`. Added by Phase D so existing rebind dashboards can group bumps by class without correlating with `chain.init.*` events.
- **跳針 ("tiào zhēn", "needle-skipping")** — user-coined term for the AI behaviour pattern of repeatedly re-reading the same file or re-running the same operation post chain reset, never converging. Originating observation: 11 consecutive `read` calls on the same offset of `enterprise_security_operation_analysis.md` in ses_1e56ed3f9ffeb*, 2026-05-12. This work's primary motivating failure.
