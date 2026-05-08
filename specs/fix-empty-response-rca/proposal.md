# Proposal: fix-empty-response-rca

## ADDENDUM 2026-05-09 — itemCount RCA is gpt-5.5-specific

The "300-400 input items → ws_truncation / server_failed" failure
region documented below is gpt-5.5-specific. Comparing model configs
in [refs/codex/codex-rs/models-manager/models.json](../../refs/codex/codex-rs/models-manager/models.json):
gpt-5.5 hard-caps `max_context_window` at 272 K, while gpt-5.4 / 5.3
have 1 M (4× headroom). The 51 events recorded in our JSONL on
2026-05-07 were all gpt-5.5 sessions. Prior models tolerated 800+
input items because the codex backend had room to absorb the
structural overhead; gpt-5.5 backend tightens.

User-observable consequence: paralysis-loop wave starting late April
2026 / early May 2026 — exactly the gpt-5.5 release window. We were
on 5.4 / 5.3 for the prior 4 months without seeing the pattern.

Current mitigation: paralysis × bloated-input → compaction trigger
(commit `077214fe7`, [packages/opencode/src/session/prompt.ts](../../packages/opencode/src/session/prompt.ts)
threshold=250). See [docs/events/event_20260509_gpt55_itemcount_truncation_rca.md](../../docs/events/event_20260509_gpt55_itemcount_truncation_rca.md).

The L1–L7 landmines below are still real but the headline RCA
("itemCount drives codex backend failure") is now scoped: it's a
gpt-5.5 residency tax. If OpenAI later raises gpt-5.5's max
context window to 1 M, the trigger falls dormant — paralysis-gated
so non-stuck sessions never pay the compaction cost.

---

## Why

[`codex-empty-turn-recovery`](../codex-empty-turn-recovery/) (state: `implementing`, awaiting live A6 evidence) shipped the **result-layer** treatment for codex empty responses: classify cause family, write JSONL forensic log, automatically retry once on WS truncation, never hard-error. As recorded in [docs/events/event_20260507_codex-empty-turn-loop-prevention-explained.md](../../docs/events/event_20260507_codex-empty-turn-loop-prevention-explained.md), that fix is **upstream-of-loop, not anti-loop**:

> 我們做的修復處理了「empty response 變成 hard blocker」這個結果層問題，沒有處理上游產生 empty response 的根因。

The post-implementation landmine inventory in that event note identified seven separate root-cause hazards (L1–L7) that codex-empty-turn-recovery does NOT address. Several of them are **direct triggers for empty responses**, not amplifiers — meaning even with the recovery layer in place, these landmines will keep producing empty turns at a non-trivial rate, and the JSONL log will keep filling with cluster patterns the operator has no automated remediation for.

This spec is the root-cause attack on those landmines: where does the empty response actually come from in the upstream pipeline, and what behavioral change in compaction / rotation / retry-orchestration / runloop-policy stops the cause rather than just logging the result.

## Original Requirement Wording (Baseline)

- "你認為我們的compaction/rotation那邊還埋藏了地雷導致 empty response嗎" *(2026-05-07 — user prompt that surfaced the L1–L7 inventory)*
- "開新plan fix-empty-response-rca" *(2026-05-07 — directive that opened this spec)*
- Implicit: build on codex-empty-turn-recovery; spec scope is RCA + remediation plan, not just instrumentation.

## Requirement Revision History

- 2026-05-07: initial draft created via plan-init.ts. Imports the L1–L7 landmine catalogue from event_20260507_codex-empty-turn-loop-prevention-explained.md as the working scope baseline.

## Effective Requirement Description

1. For each empty-response landmine surfaced by the codex-empty-turn-recovery analysis (L1–L7 below), this spec MUST decide one of: (a) take into scope and design a remediation, (b) explicitly defer with stated reason, or (c) hand off to a separate spec with named slug.
2. In-scope landmines MUST trace to a behavioral change in opencode-side code (compaction, rotation, retry orchestration, runloop) — server-side codex behavior remains out of our control.
3. Remediations MUST NOT regress codex-empty-turn-recovery's invariants (INV-01 no-throw, INV-04 always log, INV-08 retry cap=1, INV-13/14 enum stability). Where conflict arises, this spec opens an `extend` revision on codex-empty-turn-recovery rather than mutating it silently.
4. Spec output MUST be evidence-driven: every landmine remediation cites the JSONL log signal that should fire BEFORE the remediation triggers, and the metric reduction that should be observable AFTER it ships.
5. The runloop's `?` nudge stays broad per Decision D-4 of codex-empty-turn-recovery — this spec MAY add a session-scoped nudge counter to break recursive empty-loop scenarios (L7), but MUST NOT narrow the per-turn nudge trigger.

## Scope (per-landmine treatment, draft — needs user decision)

The seven landmines, copied verbatim from event_20260507 with this spec's tentative treatment proposal:

### IN — confirmed direct empty-response triggers (high severity)

- **L1 — 40K prefix stable equilibrium (compaction self-loop)**: ses_204499 showed `cache_read = 37888` constant across many consecutive turns, suggesting some opencode-side layer collapses to a stable compacted snapshot that hides turn-to-turn progress. Need to identify the responsible compaction trigger and break the equilibrium (probably: predict-cache-loss preemptive compact per `feedback_compaction_two_principles.md` is firing on every turn instead of on threshold). Treatment: trace the 37888 origin, change the trigger condition, verify in retest. **Cannot reuse codex-empty-turn-recovery's retry — same prefix sent twice gets the same truncation.**
- **L2 — Account rotation cold prefix → ws_truncation**: yeatsraw inheriting a 222K-token prefix from yeatsluo / ivon0829 collapses prompt cache, attempt 1 sees 222K cold, hits WS idle timeout. Need: rotation policy change so either (a) account stays bound for a full turn even if cockpit reports it about to deplete, or (b) prewarm the cache_key on the new account before the first request hits, or (c) compact-then-rotate so the cold prefix is small. **Memory `feedback_compaction_two_principles.md` already covers (b) as a load-bearing principle but it's not implemented.**

### IN — interaction risks (medium severity, tentatively in scope)

- **L3 — `store: false` × retry interaction**: each codex retry re-does reasoning + tool prep from scratch because the backend doesn't persist intermediate state. If attempt 1 truncated due to oversize prefix, attempt 2 will too. Treatment options: enable `store: true` on the retry attempt only (so backend keeps reasoning state across the retry boundary) OR shrink prefix between attempts via post-empty compaction.
- **L4 — `unknown` finishReason might trigger rotation thrash**: rotation3d's heuristics may interpret our new `finishReason: "unknown"` (emitted for ws_truncation per codex-empty-turn-recovery DD-9) as "this account is bad, rotate". Each rotation creates a new cold prefix → another L2 trigger → more ws_truncation → more rotations. Treatment: audit rotation3d's per-finishReason policy, add an epoch barrier so empty-turn `unknown` does not promote rotation.
- **L7 — Recursive nudge-empty loop**: after our retry exhausts, the runloop fires `?` nudge. The nudge response goes through the same pipeline; if it's also empty (because L1/L2/L3 still apply), classifier fires again, nudge fires again. INV-08 is per-turn (max 1 retry) but there's no session-scoped circuit breaker. Treatment: add a session-scoped consecutive-empty counter; after N (3? 5?) hit operator escalation rather than infinite nudging.

### OUT — driven by separate signals (deferred)

- **L5 — `reasoning.effort` / `include: encrypted_content` still being sent**: codex-empty-turn-recovery's D-3 audit-then-act decision explicitly defers this until production logs show ≥ 5% rate. **This spec does NOT pre-empt that audit threshold**; it monitors the JSONL signal and lets D-3 trigger an `extend` revision on codex-empty-turn-recovery when the threshold hits. Hand-off: stays as codex-empty-turn-recovery's responsibility.
- **L6 — Compaction's input-token accounting on empty turns**: theoretical interaction risk; no observed evidence yet. Treatment: deferred until L1's compaction-trigger investigation surfaces concrete data on whether compaction is firing prematurely.

## Non-Goals

- Reducing codex backend's empty-response rate from the server side (we can't change codex)
- Replacing the runloop nudge wholesale (D-4 is preserved)
- Rewriting the rotation3d module (this spec edits its policy hook for `unknown` finishReason; full rewrite is out of scope)
- Any change that would mutate codex-empty-turn-recovery's invariants without first opening an `extend` revision

## Constraints

- `feedback_compaction_two_principles.md` (load-bearing): server-side compaction (kind 4 + Mode 1 inline) + predict-cache-loss preemptive compact are the two principles. Anything we change must remain consistent.
- `feedback_provider_boundary.md`: compaction policy lives in opencode runtime, not codex provider package. Rotation policy lives in `rotation3d.ts`. Each landmine remediation respects the existing layer boundaries.
- codex-empty-turn-recovery invariants INV-01, INV-04, INV-08, INV-13/14: must not regress.
- `feedback_minimal_fix_then_stop.md`: ship the smallest viable fix per landmine, do not bundle architecture rewrites.
- `feedback_no_silent_fallback.md`: every remediation surfaces its decision via log / metric; no silent path changes.

## What Changes

Preview, subject to designed-state refinement:


- **Compaction trigger logic** (L1): probably in `packages/opencode/src/session/compaction/`; identify the path producing the 37888 stable equilibrium and gate it on actual turn progress, not predicted cache loss
- **Rotation policy hook** (L2 + L4): probably in `packages/opencode/src/account/rotation3d.ts` and the cockpit quota integration; tighten the rotation trigger so `unknown` doesn't count as a degradation signal, and consider prewarm-before-rotate
- **Retry orchestration on store flag** (L3): possibly in `packages/opencode-codex-provider/src/provider.ts` retry path — opt into `store: true` for the retry attempt (would be an `extend` revision on codex-empty-turn-recovery)
- **Session-scoped nudge counter** (L7): probably in `packages/opencode/src/session/prompt.ts` or a sibling — track consecutive empty-turn classifications per session; on threshold, raise operator alert + suspend nudges

## Capabilities

### New Capabilities (subject to scope confirmation)

- Compaction equilibrium detection: surface a metric for "same compacted prefix replayed N times" so L1 is observable
- Pre-rotation cache prewarm: when rotation is imminent, send a small probe to the new account's `prompt_cache_key` before retiring the old one
- Per-session empty-turn circuit breaker: after N consecutive empty turns, stop auto-nudging and surface to operator

### Modified Capabilities

- Rotation policy: `unknown` finishReason from empty-turn classifier is no longer a degradation signal
- Retry behavior: optional `store: true` on retry attempt
- Compaction trigger: gated on observed turn progress, not predicted cache loss alone

## Impact

- **Code**: opencode runtime (compaction + rotation + session prompt); minimal codex-provider changes (only L3 retry-store flag, via `extend` on codex-empty-turn-recovery)
- **Sessions**: post-fix sessions should see (a) lower L1 stable-equilibrium rate, (b) lower L2 cold-prefix rate, (c) shorter recursive-empty loops bounded by L7 circuit breaker
- **Telemetry**: the JSONL log already captures the source signals (M3 retry rate, M5 server_empty_with_reasoning rate, M6 account distribution). New metrics: M8 stable-equilibrium count, M9 prewarm hit rate, M10 circuit-breaker firings.
- **Operators**: existing runbook gains additional incident playbooks for each cause-family that now has a remediation path
- **Tests**: each landmine treatment ships with regression tests; test-vectors.json gains entries per remediation

## External References (Evidence)

| Source | What it documents | Relevance |
|---|---|---|
| [docs/events/event_20260507_codex-empty-turn-loop-prevention-explained.md](../../docs/events/event_20260507_codex-empty-turn-loop-prevention-explained.md) | L1-L7 landmine analysis post codex-empty-turn-recovery | This spec's primary scope source |
| [`specs/codex-empty-turn-recovery/`](../codex-empty-turn-recovery/) | Result-layer empty-response handling (classifier + log + retry) | Invariants to preserve; D-3 audit hand-off (L5) |
| memory: `feedback_compaction_two_principles.md` | Two compaction load-bearing principles | L1 trigger investigation anchor |
| memory: `project_account_switch_compaction_inloop.md` | Account-switch compaction had in-loop path (FIXED 2026-04-29) | L2 / L4 prior history; verify previous fix wasn't undone |
| memory: `project_codex_cascade_fix_and_delta.md` | UNKNOWN no-promote (2026-03-30 fix) | L4 anchor — verify the fix still holds against new `unknown` source |
| memory: `project_preexisting_codex_issues.md` | Pre-existing codex issues — subagent wait, infinite thinking, no response, high tokens | L7 ancestor pattern |
| Live JSONL log post-A6 deploy: `<state>/codex/empty-turns.jsonl` | Empirical cause-family distribution | Required input to designed-state — without it, scope decisions on L1-L4 are speculative |

## Decisions

- **D-1 (2026-05-07, user)** — **Scope cut: L1+L2+L3+L4+L7 in scope; L5+L6 out**. L5 stays under codex-empty-turn-recovery's D-3 audit; L6 deferred until L1 investigation surfaces evidence. (Closes Open Question 1.)
- **D-2 (2026-05-07, user)** — **Peer / standalone spec relationship to codex-empty-turn-recovery**. fix-empty-response-rca runs in its own folder. When L3 needs to mutate `packages/opencode-codex-provider/`, it does so by opening a formal `extend` revision on codex-empty-turn-recovery rather than editing that spec's artifacts directly from this folder. Boundaries stay clean. (Closes Open Question 2.)
- **D-3 (2026-05-07, user)** — **Do NOT block advancement on production JSONL data**. Proceed to `designed` based on analytical severity ranking (L1+L2 high, L3+L4 medium, L7 medium-runloop). Trade-off acknowledged: when production data eventually arrives, phase ordering may need revision (`amend` mode at most; structural change unlikely since severity ordering is stable). (Closes Open Question 3.)
- **D-4 (2026-05-07, accepted from proposal)** — **No SSDLC profile**. Engineering RCA, not regulated change. `.state.json.profile` stays `[]`. (Closes Open Question 4.)
- **D-5 (2026-05-07, user)** — **One spec, phase-divided** by landmine in-scope set (L1, L2, L3+L4 paired, L7 separate). Sub-specs only get spawned if a phase grows past 8 tasks during designed-state work. (Closes Open Question 5.)
- **D-6 (2026-05-07, user)** — **Pause spec at `proposed`; wait for production JSONL evidence before advancing to `designed`**. This **overrides D-3** ("don't block on production data, proceed by analytical severity"). Trigger for the override: code spikes on 2026-05-07 revealed that L4 and L7 are over-scoped (L4's UNKNOWN-no-promote guard at `rate-limit-judge.ts:39-52` is still holding; L7's `emptyRoundCount` already caps at 2 in `prompt.ts:1446-1467`). Without runtime data we cannot honestly prioritize among L1, L2, L3 either. Resume signal: user reports a new empty-response incident, OR codex-empty-turn-recovery hits its A6 24h soak threshold with concrete cluster patterns in `<state>/codex/empty-turns.jsonl`.
- **D-7 (2026-05-07, user)** — **RESUME**. ses_204499eecffe2iUTzeXyiarlnq looped again ~30 min after the codex-empty-turn-ws-snapshot-hotfix daemon restart. Live JSONL evidence (logSeq 0/1/2) confirmed: hotfix works (wsFrameCount populated, ws_truncation correctly classified, retry-once-then-soft-fail mechanism + INV-08 cap both fired as designed), BUT the loop continues because the model re-plans from a degraded compaction equilibrium (cache_read locked at 36352 — same mechanism as the original 37888 lock, slightly different value). Plus L2 fired in real time: account rotated from `ivon0829` to `yeatsluo` mid-session after the WS truncation chain. Both L1 and L2 are now empirically proven, not just spike-inferred. Spec moves to designed-state with **L1 + L2 as the focus**; L3/L4/L7 stay deferred per existing Scope Refinement Backlog.

## Live Recurrence Evidence (2026-05-07, post-hotfix)

Session: `ses_204499eecffe2iUTzeXyiarlnq` (the same session that motivated codex-empty-turn-recovery).

Hotfix verification (codex-empty-turn-recovery wiring works as designed):

```
logSeq 0  ivon0829  ws_truncation  wsFrameCount=3  retryAttempted=false
logSeq 1  yeatsluo  ws_truncation  wsFrameCount=2  retryAttempted=false
logSeq 2  yeatsluo  ws_truncation  wsFrameCount=2  retryAttempted=true  retryAlsoEmpty=true  previousLogSequence=1
          → recoveryAction demoted to pass-through-to-runloop-nudge per INV-08
```

Loop continues anyway (DB row inspection of subsequent turns):

| Turn | Account | tokens_input | cache_read | reasoning | finish |
|---|---|---|---|---|---|
| (latest) | yeatsluo | 0 | 0 | 0 | (empty) |
| -1 | yeatsluo | 5999 | 36352 | 0 | tool-calls |
| -2 | yeatsluo | 6062 | 36352 | 0 | tool-calls |
| -3 | yeatsluo | 42447 | 0 | 0 | tool-calls |
| -4 | yeatsluo | 21622 | 20992 | 0 | tool-calls |
| -5 | yeatsluo | 20867 | 20992 | 0 | tool-calls |
| -6 | (ROTATION) | 0 | 0 | 0 | unknown |
| -7 | ivon0829 | 3142 | 38912 | 0 | tool-calls |
| -8 | ivon0829 | 2769 | 38912 | 0 | tool-calls |

Pattern: cache_read locks at 36352 (same mechanism as original 37888); reasoning sticky 0 (same as original); rotation triggered after empty turn (NEW evidence — was theoretical before).

L4/L7 status from this session:

- **L4**: rotation **did fire** mid-session (ivon0829 → yeatsluo). Open question for design phase: **what triggered it**? UNKNOWN-no-promote guard SHOULD have prevented unknown-finishReason from triggering rotation. Either there's another trigger path (retry-also-empty as a separate signal? quota threshold coincidence?), or the guard is bypassed somehow. **Spike before designing DD-2.**
- **L7**: not the source of the loop in this session; emptyRoundCount cap at 2 is doing its job. The loop was driven by per-round empty turns, not within-round nudge recursion. L7 stays P3 observability work.

## Spike Findings (2026-05-07)

Code-reading spikes performed before pause. Findings inform the resume:

- **L1 (compaction 37888 equilibrium)** — culprit located at [packages/opencode/src/session/prompt.ts:1884](../../packages/opencode/src/session/prompt.ts#L1884): `predictedCacheMiss = continuationInvalidatedAt ? "miss" : "unknown"` is sticky once `continuationInvalidatedAt` ever fires. Combined with the gate at [prompt.ts:468-471](../../packages/opencode/src/session/prompt.ts#L468-L471), `cache-aware` compaction triggers every turn producing deterministic 37888-byte output. Resume: design.md DD-1 will gate the flag (compact-once-then-clear, or stateful check).
- **L2 (rotation cold prefix)** — confirmed: zero prewarm path today. `findFallback()` returns new `accountId`; next request immediately uses new `prompt_cache_key = codex-${newAcctId}-${sessionId}` with no warmup. Three remediation directions: prewarm hook / delay-to-turn-boundary / compact-then-rotate. Choice needs runtime data.
- **L3 (store=false × retry)** — confirmed: we always send `store: false` (matches Codex CLI). `refs/openclaw/CHANGELOG.md` shows OpenAI direct-Responses paths force `store: true` for multi-turn state. Possible: opt into `store: true` on the retry attempt only. Worth audit-then-act.
- **L4 (unknown → rotation thrash)** — **DOWNGRADED**: spike found UNKNOWN-no-promote guard still holding at [packages/opencode/src/account/rate-limit-judge.ts:39-52](../../packages/opencode/src/account/rate-limit-judge.ts#L39-L52). Not currently a live landmine; reframed as "future fragility — if rotation ever starts reading finishReason, the guard must be preserved AND should read providerMetadata.openai.emptyTurnClassification.causeFamily as a finer signal."
- **L7 (recursive nudge)** — **DOWNGRADED**: spike found `emptyRoundCount === 2` already triggers natural-stop break at [packages/opencode/src/session/prompt.ts:1446-1467](../../packages/opencode/src/session/prompt.ts#L1446-L1467). The original "infinite loop" framing was wrong. Real gap: no cross-round persisted accumulator; ses_204499 ran 17 rounds because each user message restarts the loop counter. Reframed as observability work (capture cross-round empty-turn density), not infinite-loop prevention.

## Scope Refinement Backlog (apply on resume)

When this spec resumes (per D-6 trigger), apply this scope refinement before drafting design.md:

- L1 stays in scope at P0 (concrete code regression, ready to design)
- L2 stays in scope at P1 (3 directions; production data ranks them)
- L3 stays in scope at P2 (audit-then-act based on retry-also-empty cluster rate)
- L4 reframed as P3 prophylactic ("preserve UNKNOWN-no-promote; recommend reading causeFamily on any future rotation policy refinement")
- L7 reframed as P3 observability ("capture cross-round empty-turn density; surface via JSONL or new metric, do not add new circuit-breaker logic")

## Resolved Open Questions

All five open questions resolved by Decisions D-1 through D-5 above.

The remaining design-phase questions (which fall under `designed`-state work, not `proposed`-state blockers) are:

- Concrete identity of the 37888-equilibrium-producing layer (L1) — needs code reading
- Specific rotation3d hook(s) that interpret finishReason as degradation signal (L4) — needs code reading
- Threshold value for the L7 session-scoped circuit breaker (3? 5? configurable via tweaks.cfg?)
- Whether L3's `store: true` retry needs new `extend` revision on codex-empty-turn-recovery to be ready before this spec's L3 phase can ship, or whether they can be parallel

These are tracked into `design.md` once the spec is promoted to `designed`.
