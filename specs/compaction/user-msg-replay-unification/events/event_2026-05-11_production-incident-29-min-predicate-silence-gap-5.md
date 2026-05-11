---
date: 2026-05-11
summary: "production incident — 29-min predicate silence gap + 581KB narrative anchor + rebind dropping post-anchor journal"
---

# production incident — 29-min predicate silence gap + 581KB narrative anchor + rebind dropping post-anchor journal

## Session

`ses_1e8cbd779ffezUjDVUZXBvwkqy` — codex / gpt-5.5, grafcet renderer L3 detour debugging task. Captured 2026-05-12 04:14–04:28+08:00.

## Symptom (user-visible)

- UI showed "正在收集上下文 · 9 分鐘 45 秒" with 連環 "你說得對 + 讀取" tool-calls (跳針).
- Context indicator dropped to ~9% remaining.
- After ~10 minutes wait, UI suddenly "dumped a pile of summary" and went to waiting_user.

## Compaction timeline for this session (debug.log)

```
01:11:55  compaction 1 (early, sparse)
02:23:27  +1h12m
03:08:31  +45m
03:12:04  +4m
03:27:52  → 03:56:27  ←  13 compactions in 30 minutes (cluster, every 1.5–4 min)
03:56:27 → 04:25:19   ←  29-MINUTE SILENCE GAP (the anomaly)
04:25:19  finally fires (observedTokens=297001 > contextLimit=272000, overflow)
04:28:14  +3m
```

ALL 18+ compactions in this session have `observed=rebind`. None overflow- or cache-miss-predicted (until the forced 04:25 one).

## Three distinct bugs in one trace

### Bug A — predicate silence gap (29 min)

During 03:56–04:25 the compaction predicate evaluated every round and returned `outcome=none, reason=no_predicate_matched` while ctxRatio climbed 0.75 → 0.81. By the time it triggered, observedTokens=297001 (already PAST the 272K context limit). The 0.9 threshold for codex is too high when journal grows monotonically — the gate fires only after the model has already corrupted itself.

Specifically: round 1405 ctxRatio=0.7539 → no predicate matched → round 1421 observedTokens=297001 → needsCompaction=true.

### Bug B — rebind drops post-anchor journal (跳針 root cause)

`[2026-05-12T04:18:16.052] loop:rebind_stream_anchor_applied` rebuilt the stream as `anchor_body + 49 messages_before + 49 messages_after`, reconstructedTokens=220248. The post-anchor journal (model's in-progress L3-detour RCA reasoning across rounds ~1395–1411) was discarded. The model then re-walked L5 projection → L5 clearance → back to L3, looping because the previously-derived insight was no longer in the prompt. **This is what user perceived as "跳針 = lost knowledge"** — and they were correct; it's prompt content loss, not model regression.

### Bug C — narrative anchor body bloat

At 04:25:13 `compaction.anchor.sanitized` reports `originalLength: 581372` chars (~145K tokens). Across the 18 compactions in this session, the narrative-kind anchor body grew monotonically without LLM-side re-compression. hybrid_llm enrichment runs in background (mode=plugin) after each narrative write, but subsequent rebinds appear to fire before enrichment converges. So the anchor body bloats — defeating compaction's purpose.

## Reconciling with prior MEMORY hypotheses

- `project_compaction_replay_three_siblings_2026_05_09` — `rebind-preemptive` sibling confirmed in production. Adds new dimension: rebind doesn't just swallow user msg; it discards post-anchor journal of in-progress reasoning.
- `project_runtime_selfheal_layers_2026_05_08` — tool-repeat RCA assumption confirmed. Mechanism: paralysis self-heal triggers rebind → rebind drops post-anchor journal → model re-derives same conclusions → tool-repeat → ctx overflow → forced compaction. End-to-end causal chain has production evidence.

## Why the 29-min gap

Hypothesis (needs verification): after the 03:27–03:56 rebind cluster subsided (paralysis stopped triggering), no rebind = no compaction (since ALL compactions are rebind-observed). ctxRatio-based predicate was the only remaining gate, and it never tripped before overflow.

This points to a structural issue: compaction is over-coupled to rebind. When rebind quiets down, compaction starves even as ctx pressure rises.

## Proposed solution directions (to triage)

1. **Lower ctxRatio threshold for codex** from 0.9 → 0.75 (or use second-derivative: trigger on Δctx/Δround). MEMORY rule already says "ctx>50% + predicted cache lost → compact"; this case violated the spirit.
2. **Rebind must replay post-anchor journal**, same way user-msg-replay-unification replays the unanswered user msg. Currently rebind reconstructs `anchor + 49 before + 49 after` but the "after" appears to be tool-output stream items only, not the model's in-progress reasoning steps.
3. **Cap narrative anchor body size** (e.g., 200K chars) + force hybrid_llm re-compression when threshold exceeded, blocking the next rebind-compaction until enrichment lands.
4. **Tool-repeat detector** as independent compaction trigger (orthogonal to ctx pressure): N identical tool calls within K rounds → force compaction (with chain reset, per "斷尾求生" rule).
5. **Decouple compaction from rebind observation**: rebind should be ONE trigger, not the dominant one. Audit why this session has 100% rebind-observed compactions.

## Spec impact

This expands user-msg-replay-unification's scope from "replay unanswered user msg post-anchor" to "post-anchor journal preservation across rebind". Consider promoting Bug B into the existing spec as an additional invariant, and spinning Bugs A + C into a new plan (`/plans/compaction_predicate-gap-and-bloat/` or similar).

---

## Follow-up RCA (deepened during chat) — recall affordance gap is the dominant cause

Operator hypothesis (verified): user observed AI never called `recall` during 跳針, suspected AI didn't know tool results were stubs.

### Code audit findings

1. **No AI-callable recall tool exists**
   - `Memory.Hybrid.recallMessage` ([memory.ts:499-508](../../../packages/opencode/src/session/memory.ts#L499-L508)) is internal API only.
   - `ls packages/opencode/src/tool/ | grep -i recall` → empty. No `recall.ts`.
   - `grep -rln "recallMessage" packages/opencode/src` → defined in memory.ts, never called.

2. **Documented `OverrideParser` auto-recall does not exist**
   - Comment on recallMessage says "OverrideParser in prompt.ts checks whether the recalled content is already in journal".
   - `grep -rln "OverrideParser\|Recalled from earlier"` → no results.
   - The auto-recall feature was designed but never implemented. recallMessage is dead code.

3. **Narrative anchor body is unaddressable prose, not indexed pointers**
   - `buildUserPayload` ([compaction.ts:3120-3168](../../../packages/opencode/src/session/compaction.ts#L3120-L3168)) instructs LLM to "Produce the new anchor body now" — produces narrative prose. No requirement to emit a tool_call_id index.
   - Server-side compaction (codex kind 4) preserves `previous_response_id` chain → tool results addressable by id on codex side.
   - Narrative compaction loses both the chain AND any local index → tool history is genuinely irretrievable after rebind+narrative.

### Causal chain (revised)

```
rebind (rate-limit rotation / daemon restart / paralysis self-heal)
  → codex previous_response_id chain breaks
  → falls back to local narrative compaction
  → tool results pre-anchor collapse into prose anchor body
  → AI sees narrative summary, no tool_call_id index, no recall tool
  → AI cannot tell its memory is hollow
  → AI re-does tool calls assuming new context
  → fresh tool calls also get summarised on next compaction
  → 跳針 (loops without progress)
  → ctx eventually overflows → forced narrative compaction → 581K bloat
```

### Mitigation must be three-layer (operator confirmed)

| Layer | Change | Effect |
|---|---|---|
| **L1 — prompt-side affordance** | Modify `buildUserPayload` to require an explicit `## TOOL_INDEX` section in the anchor body: `(tool_call_id, tool_name, args_brief, status, output_chars)` per pre-anchor tool call. | Anchor becomes addressable; AI sees what's recallable. |
| **L2 — AI-callable recall tool** | Add `packages/opencode/src/tool/recall.ts` exposing `recall(tool_call_id: string)` → returns full original tool output. Backed by `Memory.Hybrid.recallMessage` extended to lookup by tool_call_id (currently msg_id only). Available in build agent tool catalog. | AI gains agency to retrieve stubbed content. |
| **L3 — rebind-aware system note** | When narrative compaction completes with `observed=rebind`, post-anchor inject a system message: "Your tool history before this point has been narrative-compacted. Tool results listed in TOOL_INDEX are stubs — call `recall(tool_call_id)` to retrieve original output. Do not assume prior tool results are accurate without recall." | AI is told it's amnesic; learns when to recall. |

Without all three: L1 alone → AI knows what's recallable but can't recall. L2 alone → AI has tool but doesn't know it needs to. L3 alone → AI knows it's amnesic but has nothing to call or address.

### Constraint on the original five solution directions

The original Bug A/B/C analysis still stands but recall-affordance subsumes part of Bug B's effect:
- Bug B's "rebind drops journal" matters less if AI can recall pre-anchor tool outputs by id.
- Bug A (predicate gap) and Bug C (anchor bloat) remain independent — they govern WHEN compaction fires and HOW LARGE the anchor gets, orthogonal to recall affordance.

Recommended split:
- **New plan: `/plans/compaction_recall-affordance/`** — L1+L2+L3 above. Highest priority because it bounds the damage of any compaction event, including future overflow / rotation / restart scenarios.
- **Follow-up plan: `/plans/compaction_predicate-and-bloat/`** — Bugs A + C, deferrable once recall-affordance lands.
- **Amend user-msg-replay-unification spec**: add invariant that rebind must not silently drop reasoning continuity (Bug B partial coverage).

### Why this is the dominant fix

90% ctxRatio threshold is correct IF compaction stays in server-side path (codex kind 4 preserves chain). The failure mode is exclusively when rebind forces narrative — and narrative without recall = guaranteed knowledge loss with no recovery channel. Fixing recall affordance closes the only loss-creating path; tuning thresholds is secondary.

