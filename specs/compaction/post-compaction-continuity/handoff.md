# Handoff — compaction_post-compaction-continuity

## Execution Contract

- **Mode:** behaviour-preserving fixes around a correct compaction. Land slices
  **S1 → S2 → S3**; each observably equivalent to current behaviour **except** the
  defect it fixes. Do NOT change the CompactionManager intake contract (it is
  living and correct).
- **S1 first.** It removes the enrichment-as-compaction misreport (the false
  "double compaction" source) AND restores the suppressed amnesia notice — highest
  value, lowest risk. Ship it with its regression test before S2/S3.
- **Reuse the central-manager provider seam for S2** — do not invent a new gate;
  extend `compaction-provider-strategy` (the DD-12 precedent).
- **S3 must not create an infinite loop** — only resume a genuinely unfinished
  turn, and verify it does not fight the `evaluateUnproductiveRound` breaker
  (committed 95a3f44d9).
- **Per slice:** in-scope compaction suite stays green + the new regression tests
  pass. A red suite blocks the slice.
- **Daemon discipline (AGENTS.md / CLAUDE.md):** never self-spawn/kill/restart;
  restart only via `webctl.sh restart`. Back up `~/.config/opencode/` before the
  first code edit. Update **both** enablement registries if a flag is added.
  Implement off-main via beta-workflow. Default: no PR.

## Required Reads

Before writing code, read (in order):

1. This package's `design.md` (DD-1..DD-4) and `spec.md` (Requirement/Scenario).
2. `data-schema.json` (the recentEvent kind delta + amnesia decision + provider gate).
3. The incident: `event_search "compaction continue no_user_after_compaction"` /
   the forensic timeline in `proposal.md` (session ses_14d8b1ed).
4. Living precedent: `specs/compaction/central-manager` (provider strategy seam,
   the manager contract this builds on) and DD-12.
5. Current surfaces: `session/index.ts` (SessionRecentEvent), `session/compaction.ts`
   (enrichment push :1732, `injectContinueAfterAnchor` :2732),
   `context-fragments/amnesia-notice.ts` (`decideAmnesiaInjection`),
   `session/prompt.ts` (`no_user_after_compaction`),
   `compaction-provider-strategy.ts`.

## Stop Gates In Force

Pause and surface (do not work around) when:

- A recentEvents consumer turns out to depend on enrichment being
  `kind:"compaction"` (S1) — record a decision before changing it.
- The S2 provider gate would change codex/general compaction — that is out of
  scope; keep the gate provider-local.
- The S3 resume risks re-firing a finished turn or fighting the unproductive-round
  breaker — stop and reconcile, do not ship a loop.
- Any change touches daemon lifecycle, enablement registry, or shared XDG config
  without the required backup/registry-sync.

## Execution-Ready Checklist

- [ ] design.md + spec.md + data-schema.json + sequence.json read.
- [ ] central-manager provider seam + the incident timeline read.
- [ ] XDG config backed up to `~/.config/opencode.bak-<ts>-post-compaction-continuity/`.
- [ ] Fresh beta branch + worktree off main (no stale branch).
- [ ] Baseline: in-scope compaction suite green before first edit.
- [ ] S1 amnesia-notice regression test written red, then green after S1.
