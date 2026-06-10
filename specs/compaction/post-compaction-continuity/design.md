# Design: compaction_post-compaction-continuity

## Context

Builds on `compaction/central-manager` (living): the CompactionManager already
fires each compaction action exactly once and is the single monitored track.
This spec addresses what happens *around* a correct compaction, exposed by
incident `ses_14d8b1edeffegiR0uf52A2ZbT8` (claude-cli, docxmcp). Three defects,
one mid-task `cache-aware`/`legacy-large-policy` compaction:

- **D1** enrichment lifecycle events are mislabeled `kind:"compaction"` in the
  `SessionRecentEvent` ring → false "double compaction" in the Q-card tile AND
  poisoning of `decideAmnesiaInjection`.
- **D2** an unfinished turn is stranded after compaction (`empty_continue_text`
  → `no_user_after_compaction` clean exit).
- **D3** claude is forced into an unnecessary SS-break amnesia compaction on a
  tiny (8.3K / 1M) session by a legacy size/cache trigger.

## Goals / Non-Goals

### Goals
- Enrichment is reported as enrichment, never as compaction (display + decision).
- An unfinished task survives a mid-task compaction without a manual nudge.
- claude declines compactions it does not need; codex/general unchanged.

### Non-Goals
- The double-trim/dedup class (resolved by central-manager).
- Changing the CompactionManager intake contract.
- The recall affordance (recall after a real compaction is by design).
- Tuning codex/general thresholds; touching the user's `evaluateUnproductiveRound`
  breaker (95a3f44d9).

## Decisions

- **DD-1 (D1 root)**: add `enrichment` as a first-class `SessionRecentEvent.kind`
  (enum currently `rotation | compaction | cache-cliff`). Give it an optional
  `enrichment` sub-object (`status: "success"|"failed"`, `detail?`,
  `tokensBefore?`, `tokensAfter?`). The enrichment push (compaction.ts:1732) emits
  `kind:"enrichment"` instead of forcing `kind:"compaction"` with
  `observed:"enrichment:success"`. Regen SDK types. The Q-card tile renders the
  `enrichment` kind with its own label, so it no longer reads as a second
  compaction. Real compaction entries unchanged.

- **DD-2 (D1 consequence, no new logic)**: with DD-1, `decideAmnesiaInjection`'s
  existing `if (e.kind !== "compaction") continue` correctly skips enrichment
  entries, so the reverse scan reaches the real narrative compaction instead of
  short-circuiting on the fake one (sub-kind `"enrichment"` ∉
  `CLIENT_SIDE_COMPACTION_KINDS` → previously returned `{inject:false}` on the
  first iteration, suppressing the amnesia notice). Locked by a regression test:
  ring `[narrative-compaction(success:true), enrichment:success]` ⇒ `inject:true`
  for the narrative anchor (today: `inject:false`).

- **DD-3 (D2)**: a compaction interrupting an UNFINISHED turn must resume the task
  without a manual "go on". Today `injectContinueAfterAnchor` injects only when
  `PostCompaction.gather` yields non-empty text; `followUpCount:0` →
  `empty_continue_text` → nothing → `loop:no_user_after_compaction` exit while
  `hasLastFinished:false`. Resolution: detect the unfinished-turn case (assistant
  had not reached a terminal stop pre-compaction) and continue — preferred
  mechanism is the user-msg-replay-unification replay (replay the unanswered user
  request post-anchor, as the provider-switch path already does) so the next
  iteration sees a real pending user turn; fallback is a minimal synthetic
  Continue. MUST NOT continue a turn that legitimately finished (guard against an
  infinite loop), and MUST coexist with the `evaluateUnproductiveRound` breaker
  (the breaker counts non-productive rounds; a single legitimate resume is not one).
  [Mechanism choice — replay vs default-Continue — finalized during implementation
  against PostCompaction.gather semantics.]

- **DD-4 (D3)**: route the `cache-aware` / `legacy-large-policy` compaction
  decision through the central-manager per-provider seam (same class as
  central-manager DD-12). claude declines a client-side narrative compaction when
  there is no real context pressure (window-relative headroom); codex/general keep
  their behaviour byte-identical. This is provider-aware, NOT a global threshold
  change. [Exact gate — "claude skips these observeds below a window-relative
  floor" vs "claude never SS-breaks on cache-aware/legacy" — finalized in design
  review with the provider strategy.]
- **DD-13**: DD-5 (scope closure). Final disposition of the three defects after implementation: D1 (S1) shipped — enrichment is a first-class recentEvent kind, killing the tile misreport AND the decideAmnesiaInjection short-circuit (regression test TV-1). D2 (S3) shipped — snapshotUnansweredUserMessage's interrupted-tool-chain = unanswered rule generalized from overflow-only to ALL observeds, so a cache-aware (or any) compaction mid-tool-chain replays + resumes instead of stranding (loop:no_user_after_compaction). D3 / DD-4 (claude B-gate measuring the incompressible total) is now MOOT — resolved upstream by session/tool-output-redirection DD-7: with large tool results carried as ~600-token previews, promptTotal no longer balloons past the claude cold-cache B-gate, so the gate is not falsely triggered and the re-fire loop cannot form. The B-gate-on-compactible-size refactor is therefore unnecessary; left as documented hygiene, not implemented. All code lands in beta/post-compaction-continuity alongside the redirection fix; fetched back together.

## Architecture (where each fix lands)

```
compaction fires (CompactionManager — unchanged, exactly-once)
        │
        ├── recentEvents push
        │     ├── compaction event   kind:"compaction"   (unchanged)
        │     └── enrichment event   kind:"enrichment"   ← DD-1 (was kind:"compaction")
        │
        ├── decideAmnesiaInjection(recentEvents)
        │     └── skips kind!=="compaction" → reaches real compaction  ← DD-2
        │
        ├── injectContinueAfterAnchor(unfinished turn?)
        │     └── resume via replay / minimal Continue                  ← DD-3
        │
        └── trigger decision (cache-aware / legacy-large-policy)
              └── provider strategy: claude declines if no pressure     ← DD-4
```

## Critical files

- `packages/opencode/src/session/index.ts` — `SessionRecentEvent` schema (DD-1).
- `packages/opencode/src/session/compaction.ts` — enrichment push :1732 (DD-1),
  `injectContinueAfterAnchor` :2732 (DD-3), trigger gating (DD-4).
- `packages/opencode/src/session/context-fragments/amnesia-notice.ts` — verify (DD-2).
- `packages/opencode/src/session/prompt.ts` — `no_user_after_compaction` path (DD-3).
- `packages/opencode/src/session/compaction-provider-strategy.ts` — provider seam (DD-4).
- `packages/sdk/js/**` — regen for the new kind (DD-1).

## Risks / Trade-offs

- **Infinite resume loop (DD-3)** — guard: only resume a genuinely-unfinished
  turn; a finished turn stays finished. Cross-check with the unproductive-round
  breaker.
- **Tile/SDK drift (DD-1)** — the new kind must be regenerated into the SDK and
  handled by the webapp tile, else an unknown-kind render gap.
- **D3 over-reach** — must not change codex/general compaction; keep the gate
  inside the provider strategy, asserted by equivalence tests.
