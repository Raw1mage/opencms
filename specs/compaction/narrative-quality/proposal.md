# Proposal: narrative-quality

## Why

On 2026-05-09 we quantified narrative compaction's behaviour during the rebind incident on session `ses_1f47aa711ffehMSKNf54ZCHFTF`:

- **Item-count compression: extremely effective** — codex compact request had 440 input items pre-compaction; post-narrative-anchor stream collapses to 1 anchor + current-task tail; next codex `/responses` packet ≈ 3–5 items. ~100× compression. Adequate to escape the 451-item bug zone (per `feedback_compaction_two_principles.md`).
- **Prose continuity: weak** — narrative anchor body is `Memory.renderForLLMSync(mem)`, which serializes structured runtime state (todolist, active subagents, pinned skills, pinned files). It does **not** contain a prose summary of "what was discussed / what was decided / what tools ran with what outcomes."

Historical evidence that the prose gap matters:

- v5 of the post-anchor tail transformer (commit `ac2b34a0b`, 2026-05-08) wiped all completed assistant turns in the post-anchor tail. Live observation: model entered an amnesia loop — every iteration's input collapsed to a constant ~332 tokens, the model re-derived the same tool-call sequence each round with no memory of what it had just done. The post-mortem comment in `post-anchor-transform.ts` v6 notes: "upstream gets away with this because `/responses/compact` produces a compact summary inside anchor; our anchor without Phase 2 codex compactedItems carries no intra-task continuity, so dropping all assistants leaves the model blind."
- v6 (current) keeps current-task tail intact (everything since the latest user msg). This works for in-task continuity but **cross-anchor / cross-task continuity is still relayed through Memory's structured state alone**. Once the current-task tail is also truncated by the next compaction, the prose context is gone.

When server-side `/responses/compact` is unavailable (the codex account is rate-limited 429, or the endpoint times out, or non-codex provider), narrative is the floor. Today that floor is "good enough to keep the model from re-spamming tools" (thanks to v6 tail) but "not good enough to remember the conversation arc."

## Original Requirement Wording (Baseline)

- "我們的narrative compaction究竟能不能有效減少itemcount ?"
- "幫我提升narrative compaction的品質"

## Requirement Revision History

- 2026-05-09: initial draft created via plan-init.ts; quantification of item-count effectiveness vs prose-continuity gap captured.

## Effective Requirement Description

The narrative kind's anchor body should preserve **enough prose continuity that the model, looking only at the anchor, can pick up the conversation thread without re-deriving prior turns.**

This is a quality target, not a single mechanism. Three candidate approaches, each surface-level distinct, can be combined or chosen in proposed-state design:

1. **Memory.renderForLLM augmentation**: extend the renderer to include a synthesized prose section above (or alongside) the structured-state section, drawing from recent assistant text via lightweight summarization (string heuristics or single-shot LLM call).
2. **Background hybrid_llm enrichment** (extend existing infrastructure at `compaction.ts:1454+`): narrative writes a fast stub anchor; 30–60s later a background hybrid_llm pass replaces it with a higher-quality anchor. Today this is conditional on `compaction_enable_hybrid_llm=1` and applies to overflow / cache-aware / manual; expand to cover narrative when it ran as a server-side fallback.
3. **tryReplayTail merge into narrative**: include the last N rounds verbatim within the anchor body up to a budget — preserving raw assistant text so the model can read its own recent reasoning. Already exists as a separate kind; folding it into narrative makes the floor higher without an extra chain-position decision.

These are surface-level alternatives; the design phase will evaluate them on:
- Latency cost (must not block runloop)
- Token / cost (Memory enrichment is free; hybrid_llm costs a model call)
- Determinism (narrative today is fully deterministic; LLM-based enrichment introduces variance)
- Failure mode (narrative is "always succeeds"; we cannot regress that)

## Scope

### IN

- Quantitative quality bar definition (e.g. "model must remember the most recent user request and at least one decision point made during the prior turn"). May require a small benchmark / regression harness.
- Evaluation of options 1, 2, 3 above (and combinations) along the 4 axes.
- Selected option's design + implementation.
- Pre/post comparison on the post-anchor amnesia regression case from v5.
- Memory.renderForLLM signature extension if option 1 wins.

### OUT

- Replacing narrative entirely with an LLM-driven kind (narrative is the deterministic floor; that's load-bearing).
- Changing the kind chain order — narrative stays where it is in `KIND_CHAIN`.
- Touching server-side `/responses/compact` plugin behaviour.
- Touching the post-anchor tail transformer (`post-anchor-transform.ts`) — its v6 contract is upstream of narrative quality.

## Non-Goals

- Not aiming to match `/responses/compact` output quality on a token-by-token basis. Goal is "good enough to maintain conversation continuity," not "indistinguishable from server-side."
- Not aiming for narrative to never fail — it must remain the always-succeeds fallback.

## Constraints

- Latency: narrative path today is ~13ms (pure local). Any addition that pushes it past 200ms regresses the "flash compaction" UX that makes server-fallback acceptable. If LLM-based enrichment is chosen, it must be background (option 2) or explicitly bypassable.
- Determinism: narrative-as-anchor must produce a deterministic body in the same session for the same Memory state. Any LLM-augmented section must have a deterministic-fallback codepath when LLM is unavailable.
- Token cap respected: anchor body still bounded by `min(0.3 * contextWindow, target)` (`compaction.ts:962-964`).
- AGENTS.md rule 1: enrichment failures (LLM timeout / quota) must log + degrade to the deterministic floor; no silent fallback.

## What Changes

Depending on chosen option:
- **Option 1**: `packages/opencode/src/session/memory.ts` — `renderForLLMSync` signature extended; new prose-summary helper.
- **Option 2**: `packages/opencode/src/session/compaction.ts` — `narrative` becomes hybrid-eligible in the post-step background dispatch; SessionCompaction.Hybrid.runHybridLlm gains a "narrative-fallback" entry path.
- **Option 3**: `packages/opencode/src/session/compaction.ts` — `tryNarrative` body composition includes verbatim tail; `tryReplayTail` either retired or kept as separate kind.

## Capabilities

### New Capabilities

- TBD per chosen option. Common ground: narrative anchors carry enough prose so the model can resume conversation with low re-derivation cost.

### Modified Capabilities

- `tryNarrative` output composition.
- (Option 2 only) `runHybridLlm` background trigger conditions.

## Impact

- **Affected code**: `compaction.ts` and possibly `memory.ts`.
- **Affected behaviour**: post-narrative-anchor turns retain conversation context; reduced model "what were we doing again?" symptoms after server-side compact 429.
- **Affected docs**: `specs/compaction/architecture.md` § Kind chain semantics; `specs/architecture.md`.
- **Affected operators**: telemetry surface may gain a "narrative quality" metric (e.g. anchor-body composition counters).
- **Risk**: option 2 introduces a model call where there was none. Quota-management and abort-on-timeout must be in place.
- **Cross-spec coupling**: depends on `compaction/user-msg-replay-unification` resolving the user-msg-swallow defect first — without that, narrative quality work is masked by the silent-exit symptom.
