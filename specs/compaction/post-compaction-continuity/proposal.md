# Proposal: compaction_post-compaction-continuity

## Why

A live incident (session `ses_14d8b1edeffegiR0uf52A2ZbT8`, project docxmcp,
claude-cli) exposed three distinct defects clustered around a single
mid-task compaction event. The `compaction/central-manager` work already proved
the manager fires exactly once (one compact → one enrich → one recompress, no
double-trim), so these are **not** the double-trim class — they are about what
happens *around* a correct compaction: how it is reported, whether the agent is
told it happened, whether the task resumes, and whether the compaction should
have fired at all.

Forensic timeline (ts 1781113553xxx):

1. `cache-aware` narrative compaction fires on claude-cli, `trigger:legacy-large-policy`,
   anchor `8358 → 2675` tokens, SS-break + `amnesia_supersedes`.
2. `compaction.continue.injected {decision:false, reason:"empty_continue_text", followUpCount:0}`
   — no synthetic Continue.
3. `loop:no_user_after_compaction — exiting cleanly {hasLastFinished:false, taskCount:0}`
   — the loop exits **with the assistant turn unfinished**. Agent stops.
4. User says "go on"; agent resumes but must `recall` to recover context.

### The three defects

- **D1 — Enrichment mislabeled as compaction (telemetry misreport + decision
  poisoning).** `SessionRecentEvent.kind` is `rotation | compaction | cache-cliff`
  — there is no `enrichment`. So the enrichment lifecycle event
  (compaction.ts:1732) is forced into `kind:"compaction"` with
  `observed:"enrichment:success"`. Consequences: (a) the recentEvents/Q-card tile
  renders it as a second `compaction:` line → the false "double compaction" alarm
  that misled this whole investigation; (b) `decideAmnesiaInjection`
  (amnesia-notice.ts) scans recentEvents in reverse and only skips `kind !==
  "compaction"` — the fake-compaction enrichment entry is the most-recent
  `kind:"compaction"`, `success:true`, sub-kind `"enrichment"` ∉
  `CLIENT_SIDE_COMPACTION_KINDS` → it returns `{inject:false}` on the first
  iteration and **never reaches the real narrative compaction behind it**, so the
  amnesia notice for a real client-side compaction is suppressed.

- **D2 — Unfinished task stranded after compaction.** When a compaction fires
  mid-turn (`hasLastFinished:false`) and `PostCompaction.gather` yields zero
  follow-ups, `injectContinueAfterAnchor` logs `empty_continue_text` and injects
  nothing; the loop then hits `no_user_after_compaction` and exits "cleanly",
  leaving the user's in-flight request unfinished until a manual "go on".

- **D3 — Unnecessary compaction on a small claude session.** The trigger was
  `legacy-large-policy` on an 8.3K-token anchor in a claude-cli (1M-window)
  session, doing an SS-break amnesia. claude is stateless full-retransmit with a
  huge window — the same class as central-manager DD-12 (claude treated like
  codex). Had it not compacted, D1/D2 would not have been reached at all.

## Original Requirement Wording (Baseline)

- "發生了compaction。agent停止工作，叫他go on，他必須recall session." (incident report)
- "如果不是雙壓，就表示兩則訊息有一則是誤報" (the deduction that surfaced D1)

## Requirement Revision History

- 2026-06-11: initial draft; three defects (D1/D2/D3) scoped from the live incident.

## Effective Requirement Description

1. Enrichment lifecycle events must be reported as enrichment, not compaction —
   in both the recentEvents tile and the amnesia-injection decision (D1).
2. A compaction that interrupts an unfinished task must let the agent resume the
   task without a manual nudge (D2).
3. A provider that does not need a client-side narrative compaction (claude:
   stateless, huge window) must not be forced into one by a legacy size/cache
   trigger (D3) — reusing the central-manager per-provider decision seam.

## Scope

### IN
- `SessionRecentEvent` schema: a first-class `enrichment` kind (+ SDK types regen).
- `decideAmnesiaInjection`: correct behaviour once enrichment no longer wears the
  compaction label (verify it reaches the real compaction).
- Post-compaction continuation: resume an unfinished turn (D2).
- Provider-aware gating of cache-aware / legacy-large-policy on claude (D3),
  consistent with central-manager DD-12/strategy seam.

### OUT
- The double-trim / dedup class (already resolved by `compaction/central-manager`).
- Re-architecting the compaction manager itself (this builds on it, does not
  change its intake contract).
- The user's separate `evaluateUnproductiveRound` self-heal breaker (committed at
  95a3f44d9) — orthogonal; not touched here.

## Non-Goals

- Changing the recall affordance (recall after a real compaction is by design).
- Tuning compaction token thresholds for codex/general (only the claude
  necessity decision is in scope).

## Constraints

- Behaviour-preserving for codex/general (D3 must not change their compaction).
- No daemon self-lifecycle; restart via `webctl.sh restart` only. XDG config
  backed up before first edit. Update both enablement registries if a flag is added.
- Default: no PR. Implement off-main via beta-workflow.

## What Changes

- Telemetry/schema: enrichment events stop masquerading as compaction.
- Runloop: unfinished-task continuation after a mid-task compaction.
- Trigger policy: claude opts out of unnecessary cache-aware/legacy compaction.

## Capabilities

### New Capabilities
- Honest enrichment reporting: enrichment lifecycle is a first-class
  recentEvent kind, distinct from compaction (display + decision).
- Post-compaction task resume: an unfinished turn continues without a manual nudge.

### Modified Capabilities
- `decideAmnesiaInjection`: reaches the real compaction (no longer short-circuited
  by a mislabeled enrichment entry).
- claude compaction gating: declines unnecessary cache-aware/legacy compaction.

## Impact

- `packages/opencode/src/session/index.ts` (SessionRecentEvent schema)
- `packages/opencode/src/session/compaction.ts` (enrichment push 1732; continue
  injection 2732; trigger gating)
- `packages/opencode/src/session/context-fragments/amnesia-notice.ts` (verify)
- `packages/opencode/src/session/prompt.ts` (no_user_after_compaction path)
- `packages/sdk/js/**` (regen types for the new kind)
- webapp Q-card tile (render enrichment distinctly)
