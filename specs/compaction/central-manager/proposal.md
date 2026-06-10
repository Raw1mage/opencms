# Proposal: compaction_central-manager

## Why

Compaction's **post-anchor side-effects** — chain-reset publish and background
enrichment scheduling — are dispatched from multiple call sites, each carrying
its own eligibility judgment, with no single management seam. The subsystem is
in a *"wanted to unify, only did half"* state: the **trigger decision** got
centralized (`deriveObservedCondition` + 30s cooldown) and **chain-reset** got
a seam (`publishCompactedAndResetChain` → `Continuation.run`), but **enrichment
scheduling never got pulled into a seam**. The fingerprints of half-done
unification are in the code itself:

- `scheduleHybridEnrichment` is invoked from **two** layers of the same `run()`
  call stack — `writeAnchorFromBody:795` and `run():2678` — under **three**
  different eligibility checks. The L795 comment (*"Previously only run() called
  this; create() (used by /compact) skipped it"*) shows a coverage gap was
  closed by **adding a second call site** rather than by centralizing.
- The `hybridEnrichInFlight` guard exists **because** there is no single call
  point — a cross-call dedup band-aid, and a weak one (set after the async IIFE,
  cleared in `finally`).

**Verified failure (RCA `event_2026-06-10_rca-re-verified-with-hard-data-…`):**
on a claude-cli 1M session, one `cache-aware` narrative compaction scheduled
enrichment twice; the in-flight guard could not dedup the ~2ms
`drop_old_history` path; the anchor was double-trimmed **23,706 → 6,102 → 2,441
tokens (~10% retained)** in ~50ms. Combined with the `amnesia_supersedes`
SS-break (prior chain discarded), the sole-memory anchor of a 233-round session
collapsed to ~2.4K tokens → user-visible amnesia.

The double-trim is a symptom. The root cause is structural: **scattered
self-judgment call sites with no central authority that owns the decision,
dedups, and is accountable for it.** A local guard would be a fourth patch on
the pile. The cure is to finish the unification: route every
compaction/enrichment request through a single service intake — a central
`CompactionManager` — and move all policy to the manager.

## Original Requirement Wording (Baseline)

- "我不要local patch，會破壞global policy。你把整個compaction logic都盤點一遍再來看這個問題。"
- "我直覺懷疑的就是多重觸發門檻導致重複執行，每次執行都缺少去重檢查。"
- "compaction如果沒有集中在一個layer管理就是會發生這種亂象。"
- "真正的止血就是把所有分散在各處的compaction/enrichment request都wrapper成一個
  service call讓中控compaction manager來處理。然後在compaction manager端好好的分析所有的policy。"
- "好處是誰發了錯誤的request，compaction manager馬上知道，可以log，可以追蹤，可以改錯誤源頭。"
- "開plan做架構遷移。花點時間把它做到好。我不急著今天要交付。"

## Requirement Revision History

- 2026-06-10: initial draft created via plan-init.ts
- 2026-06-10: proposal authored from the conversation RCA + architecture
  direction (single service intake + central policy + accountable requests).

## Effective Requirement Description

**Primary intent (user, 2026-06-10), in order:**

1. **Centralize** all behaviour that causes compaction into one unified layer.
2. **Unify** logging and rule/policy judgment at that layer.
3. **Diagnose + fix** this specific bug (the double-trim amnesia) — RCA-driven
   behaviour correction, carried by the migration rather than patched locally.

A load-bearing insight under (1)+(2): the scattered call sites each trigger
compaction **for a different reason**. *Why* each one fires is exactly the
material an RCA needs. So every reporter must hand its **reason** to the
manager as structured data, and the manager becomes the single ledger of "why
did this session compact / enrich" — future diagnosis is a query, not the
journal-plus-two-debug.logs archaeology this incident required.

Detailed requirements:

1. **Single intake.** All compaction- and enrichment-related requests funnel
   through one `CompactionManager` service call. No subsystem calls
   `run()` / `scheduleHybridEnrichment` / `publishCompactedAndResetChain`
   directly anymore.
2. **Inversion of judgment.** Call sites become **fact reporters** (signals,
   events), not **deciders**. The manager owns every eligibility / dedup /
   ordering / cooldown decision.
3. **Central policy.** The manager holds the full policy surface in one place:
   trigger arbitration, execution (kind chain), side-effect sequencing
   (exactly-once publish + enrichment per anchor), per-session serialization,
   freerun bypass, subagent rules, provider-split (claude vs codex).
4. **Accountable requests + cause as RCA material.** Every request carries
   `origin` (call site) + a **structured `cause`** — the measured signal values
   that justified the trigger (not a freeform string), e.g. cache-aware →
   `{cacheReadTokens, hitRate, observedTokens}`, overflow →
   `{observedTokens, usableTokens}`, enrich →
   `{anchorId, anchorTokens, realPromptTokens, gateResult}`. The manager logs
   every request structurally and raises an anomaly event on policy violation
   (duplicate-enrich, compact-during-cooldown, enrich-below-floor,
   publish-kind-mismatch). The accumulated causes make the manager the **single
   RCA ledger** — and let it spot cross-trigger patterns (e.g. repeated
   cache-aware = cache thrash with an upstream cause) that blind call sites
   cannot.
5. **Structural dedup.** Single intake + per-session serialization make dedup a
   property of the architecture, not a guard. The `hybridEnrichInFlight` guard
   is retired (not replaced by a new guard).
6. **Strangler migration.** Behaviour-preserving, incremental. The **first
   slice** routes the two enrichment call sites through the manager — this alone
   structurally kills the double-trim (the immediate stop-the-bleeding), with no
   throwaway guard. Subsequent slices migrate trigger entry points and the
   publish seam.

## Scope

### IN
- A `CompactionManager` service: single intake API + request schema
  (`origin` / `cause` / tagged kind) + per-session serialization + policy
  evaluation + exactly-once side-effect fan-out + structured logging + anomaly
  events.
- Migration of the **enrichment** scheduling call sites (`compaction.ts:795`,
  `:2678`) to the manager intake (slice 1 — the止血).
- Migration of the **post-anchor side-effect** publish seam, including fixing
  the `ai_free` double-publish + hardcoded `kind:"narrative"` mismatch
  (`writeAnchorFromBody:788` vs `run():2692`).
- Migration of the **trigger entry points** that currently call `run()` with
  local judgment: main loop (`prompt.ts:2904`), paralysis-recovery (`:2350`),
  rebind-preemptive (`:2625`), `idleCompaction`, `/compact` route.
- Consolidation of the policy surface currently spread across
  `deriveObservedCondition`, `Cooldown`, `hybridEnrichmentEligible`,
  `scheduleHybridEnrichment` internal gates, and `resolvePolicy`.
- Behaviour-equivalence verification per slice + regression tests
  (one-anchor→one-enrichment; one-anchor→one-publish-correct-kind).

### OUT
- Changing **what** compaction does (kind chain algorithms, narrative body
  construction, drop_old / ai_paid mechanics) beyond exactly-once wiring.
- New compaction *capabilities* (voluntary summarize / pin / drop / recall —
  owned by `tool-output-chunking`).
- The codex server-side recompress path internals (`/responses/compact`) beyond
  routing its scheduling through the manager.

## Non-Goals

- A distributed / cross-process queue. The manager is in-process, per-daemon;
  per-session serialization matches the existing single-runloop-per-session
  invariant.
- Rewriting `Continuation.run` / rebind-epoch / amnesia-notice — the manager
  *calls* the existing chain-reset seam, it does not reimplement it.
- Tuning thresholds. Policy is *relocated*, not *re-tuned*, in this migration
  (threshold tuning is a separate follow-up; see Defect B below).

## Constraints

- **Daemon lifecycle:** never self-spawn/kill/restart. Rebuild/restart only via
  `system-manager:restart_self` (AGENTS.md). Manager must be hot-swappable
  through the normal restart path.
- **Shared config:** beta and main share `~/.config/opencode/`; tests may write
  real files. Back up XDG config before implementation per CLAUDE.md.
- **Behaviour equivalence:** each strangler slice must be observably equivalent
  except for the bug it fixes (no behaviour change to triggering, kind chain, or
  chain-reset semantics). Verified by the existing compaction test suite
  (75/75 in-scope) plus new exactly-once tests.
- **Enablement registry:** if any capability flag is added, update **both**
  `packages/opencode/src/session/prompt/enablement.json` and
  `templates/prompts/enablement.json`.
- **No throwaway guards:** the migration must not introduce a temporary dedup
  guard that needs later deletion; slice 1 achieves dedup structurally.

## What Changes

- New module: `CompactionManager` (likely `packages/opencode/src/session/
  compaction-manager.ts`), owning intake + policy + serialization + fan-out.
- `scheduleHybridEnrichment`, `publishCompactedAndResetChain`, and `run()`
  entry become **internal** to the manager (or called only by it).
- Call sites across `prompt.ts` + `compaction.ts` change from direct calls to
  `manager.submit(request)` with `origin` + `cause`.
- `hybridEnrichInFlight` removed.
- Structured logging + anomaly-event taxonomy added at the intake.

## Capabilities

### New Capabilities
- **Central compaction intake**: one `submit(request)` entrypoint; tagged
  request kinds (`evaluate` / `compact` / `enrich` / `anchorCommitted`).
- **Accountable requests**: `origin` + `cause` on every request; structured
  per-request log; policy-violation anomaly events.
- **Per-session serialization**: at most one compaction in flight, at most one
  enrichment per anchor — by construction.

### Modified Capabilities
- **Enrichment scheduling**: from 2 call sites × 3 eligibility checks → 1 intake
  × 1 policy evaluation; exactly-once per anchor.
- **Post-anchor publish**: from 3 inconsistent sites (incl. `ai_free`
  double-publish, hardcoded `kind:"narrative"`) → exactly-once, correct kind.
- **Trigger entry**: paralysis / rebind-preempt / idle / main-loop stop making
  local decisions; they report signals, manager arbitrates.

## Impact

- **Code:** `packages/opencode/src/session/compaction.ts` (5137 lines),
  `prompt.ts` (entry points + `deriveObservedCondition`), new
  `compaction-manager.ts`; telemetry (`compaction-telemetry.ts`), continuation
  (`continuation/`), `idle-compaction-gate.ts`.
- **Tests:** compaction suite + new exactly-once / accountability regression
  tests.
- **Spec/KB:** `specs/compaction/` README (Post-anchor side-effects + Known
  issue sections already added); this sub-package; `specs/architecture.md` at
  the `living` transition.
- **Operators:** new structured logs + anomaly events surface in the runtime
  event journal / dashboards.
- **Secondary defects (tracked, not all fixed here):** (B) claude A-tier gate
  keys on prompt-size not anchor-size; (C) `drop_old_history` non-idempotent.
