# Tasks — compaction_central-manager

Strangler migration. Each slice is behaviour-preserving except for the defect it
fixes, and ships green against the in-scope compaction suite (75/75) plus the new
exactly-once / accountability tests. Order matters: **S1 alone resolves the
user-facing amnesia bug** (structural stop-the-bleeding, no throwaway guard).

## S0 — Manager skeleton + intake contract

- [x] Create `packages/opencode/src/session/compaction-manager.ts` with the
      `CompactionRequest` discriminated union (evaluate / compact / anchorCommitted
      / enrich), each carrying `origin` + structured `cause` + `provider` (per
      data-schema.json).
- [x] Implement `submit(request)`: validate at the door, attach/assert fields,
      reject malformed → `malformed-request` log; structured-log every request.
- [x] Per-session serial queue + dedup keys (executionKey=sessionID,
      enrichmentKey=anchorId). Lock release at the manager boundary (finally).
- [x] Anomaly-event emitter (`duplicate-enrich`, `compact-during-cooldown`,
      `enrich-below-floor`, `publish-kind-mismatch`, `lock-held-too-long`) as
      siblings of `session.rebind_storm`.
- [x] Unit tests for intake validation + dedup + anomaly emission.

## S1 — Route enrichment through the manager (止血)

- [x] Replace `scheduleHybridEnrichment` call at `compaction.ts:795` with
      `manager.enrich(anchorId, origin="writeAnchorFromBody", cause, provider)`.
- [x] Replace `scheduleHybridEnrichment` call at `compaction.ts:2678` with
      `manager.enrich(anchorId, origin="run-postchain", cause, provider)`.
- [x] Manager dedups on `anchorId` → second call is a no-op + `duplicate-enrich`
      anomaly. Keep the existing enrichment executor (drop_old / ai_paid) unchanged.
- [x] Remove the `hybridEnrichInFlight` guard (1730 / 2150 / 2152) — no replacement.
- [x] Regression test: one narrative compaction through `run()` ⇒ exactly one
      `compaction.recompress` for that anchor (reproduces + locks the RCA).
- [x] Verify the dormant codex `runCodexServerSideRecompress` routing decision
      (keep dormant vs retire) is explicit, not accidental.

## S2 — Route post-anchor publish through the manager (anchorCommitted fact)

- [x] Introduce the `anchorCommitted` request; emit it once from each anchor-write
      funnel (`writeAnchorFromBody` for narrative/ai_free; `runLlmCompactionAgent`
      for ai_paid inline).
- [x] Manager fans out `publishCompactedAndResetChain` exactly once with the
      **actual** kind. Remove the scattered publish calls (788 hardcoded-narrative,
      2692 ai_free).
- [x] Fix the `ai_free` double-publish + `kind:"narrative"` mismatch; add
      `publish-kind-mismatch` assertion. Audit the other publish sites (2702
      chain-exhausted, 3320 reload, 4545 runLlmCompact) for correct routing.
- [x] Regression test: ai_free compaction ⇒ one publish, `kind: ai_free`, no
      spurious SS-break.

## S3 — Route trigger entry points through the manager

- [x] Convert the entry points (prompt.ts:2904 mainloop, :2350 paralysis, :2625
      rebind-preempt, :3692 idle, :3613 / routes/session.ts manual) from direct
      `run()`/`create()` calls to `manager.submit({evaluate|compact, origin, cause,
      provider})` — callers report signals, not decisions.
- [x] Move `deriveObservedCondition` arbitration + 30s cooldown + freerun/subagent
      gates into the manager policy (relocated byte-identical).
- [x] Provider class becomes an explicit request field, asserted at intake;
      preserve CLAUDE_NOOP_OBSERVED / item-count / by-request branches per §5.
- [x] Equivalence tests across claude / codex / general for each observed.

## S4 — Consolidate policy surface + tripwires

- [x] Move execution (kind chain) + side-effect eligibility + provider-split policy
      into one evaluable manager policy object; collapse the 3 enrichment
      eligibility checks into one predicate.
- [x] Wire the anomaly taxonomy to dashboards; document the RCA-ledger query path.
- [x] Consider folding the manager alongside / into the `Continuation.run`
      post-event layer (DD-9) for a unified side-effect executor.

## S5 — Complete the single track: route the last live bypass + retire dead paths (DD-13/14/15)

Surfaced by the post-merge "is it *really* fully unified?" audit. Caller-tracing
narrowed the gap: only ONE live path bypasses `requestCompact`; two look like
bypasses but are dead code; one was an over-count (already under the ledger).

- [x] **DD-13** Route the provider-switch compaction EXECUTION through the manager.
      Added `CompactionManager.requestProviderSwitchCompact(meta, exec)` — a
      transparent monitor that logs `compact requested/done` (ledger parity) and
      delegates to the caller's `writeAnchorFromBody` thunk UNCHANGED, never
      suppressing. `prompt.ts` provider-switch pre-loop no longer calls
      `compactWithSharedContext` directly. Did NOT reroute through `run()` (would
      rebuild a different narrative; the pre-loop snapshot is switch-specific).
- [x] **DD-14** Retired `SessionCompaction.process` (deprecated shim, zero live
      callers) — removed outright. `rebuildStreamFromText` confirmed dead (only a
      comment-ref in command/index.ts) AND already routes its publish through
      `CompactionManager.requestPublish` → NOT a live bypass; marked DORMANT with
      a do-not-revive-inline note, physical deletion deferred (low value; the
      full-block edit was fragile and it is not on the live track).
- [x] **DD-15** Documented `runLlmCompact`/`runHybridLlm` as accounted (internal to
      run()'s ai_paid chain at compaction.ts:2017, already under `requestCompact`)
      via DD-15 — no code change; prevents a future re-flag.
- [x] Validation: grep proves no LIVE anchor-write / compaction-execution path
      remains outside the manager; a codex/general provider-switch now emits
      `compact requested/done` in the ledger; in-scope compaction suite green
      (109/0); live fetch-back verified on a real session (one compaction → one
      enrichment → one recompress, duplicate enrich rejected, no double-trim).

## Secondary defects (separate amends, after S1–S4)

- [x] Defect B: DEFERRED per **DD-11** (tension with DD-9 A-tier floor). The
      claude A-tier enrichment gate keys on total prompt-size rather than the
      anchor's own contribution; re-scoping is tracked as a separate future amend,
      explicitly OUT OF SCOPE for this spec's verification (disposition = defer).
- [x] Defect C: make `drop_old_history` idempotent (no-op at/below target) and stop
      the round-boundary cut overshooting `KEEP_RATIO`.

## Validation / exit

- [x] Full in-scope compaction suite green (75/75) at every slice.
- [x] New exactly-once + accountability regression tests green.
- [x] XDG config backed up before first code edit (CLAUDE.md); restart only via
      `system-manager:restart_self`.
