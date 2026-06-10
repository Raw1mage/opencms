# Handoff — compaction_central-manager

## Execution Contract

- **Mode:** strangler migration, behaviour-preserving. Land slices in order
  **S0 → S1 → S2 → S3 → S4**; each slice must be observably equivalent to current
  behaviour **except** for the defect it fixes. Policy is **relocated, not
  re-tuned** — thresholds, kind chains, cooldown window, provider-split gates move
  byte-identical (DD-6).
- **S1 is the stop-the-bleeding slice.** It routes the two enrichment call sites
  through the manager and retires `hybridEnrichInFlight` with **no replacement
  guard** (DD-2/DD-3). Ship S1 with its regression test before anything else.
- **Reuse executors, don't reimplement** (DD-5): the manager calls the existing
  `run()` / `publishCompactedAndResetChain` / `Continuation.run` / enrichment
  executor unchanged. The change is *who decides and when*, not the algorithms.
- **Every request carries `origin` + structured `cause` + `provider`** (DD-4/DD-7/
  DD-8). No freeform causes; the manager is the RCA ledger.
- **Per slice:** in-scope compaction suite stays green (75/75) + new exactly-once /
  accountability tests pass. A red suite blocks the slice.
- **Daemon discipline (AGENTS.md / CLAUDE.md):** never self-spawn/kill/restart;
  restart only via `system-manager:restart_self` (or `webctl.sh restart`). Back up
  `~/.config/opencode/` before the first code edit. Update **both** enablement
  registries if any flag is added. Default: no PR unless asked.

## Required Reads

Before writing code, read (in order):

1. This package's `design.md` (esp. §3 target architecture, §5 classified
   call-site inventory, DD-1…DD-9) and `spec.md` (Requirement/Scenario blocks).
2. `data-schema.json` (intake request union, provider taxonomy, anomaly contract)
   and `sequence.json` (SEQ-1 normal, SEQ-2 duplicate-reject, SEQ-3 no-op).
3. The verified RCA: `event_search "compaction enrichment drop_old"` →
   `event_2026-06-10_rca-re-verified-with-hard-data-…`.
4. The precedent to mirror (DD-9): `session/continuation/run.ts` +
   `continuation/dispatch-dedup.ts` + `continuation/continuation-event.ts`.
5. Current code surfaces in `compaction.ts` (795 / 2678 / 788 / 1639 / 2692 /
   1704 / 1730 / 2418) and `prompt.ts` (`deriveObservedCondition` + entry points
   2350 / 2625 / 2904 / 3613 / 3692 / 1795), and provider policy in
   `context-policy.ts` / `claude-context-policy.ts`.
6. The living wiki entry `specs/compaction/README.md` (Post-anchor side-effects +
   Known issue sections).

## Stop Gates In Force

Pause and surface (do not work around) when:

- A slice cannot be made behaviour-equivalent without re-tuning a threshold —
  that's a scope change; record a decision and ask before proceeding.
- Removing a publish call site would drop chain-reset for a provider class
  (codex SS-break vs claude SL-noop must be preserved per §5.4 / DD-8).
- The codex `runCodexServerSideRecompress` (dormant/test-only) routing decision
  is ambiguous — confirm keep-dormant vs retire explicitly, don't guess.
- The in-scope compaction suite goes red, or a new exactly-once test can't be made
  to pass without changing executor behaviour.
- Any change would touch daemon lifecycle, the enablement registry, or shared XDG
  config without the required backup/registry-sync.

## Execution-Ready Checklist

- [ ] design.md + spec.md + data-schema.json + sequence.json read and understood.
- [ ] RCA event + `Continuation.run` precedent read.
- [ ] XDG config backed up to `~/.config/opencode.bak-<ts>-central-manager/`.
- [ ] Branch created (no work on a stale long-lived branch).
- [ ] Baseline: in-scope compaction suite green before first edit.
- [ ] S0 manager skeleton + intake + dedup + anomaly emitter landed with tests.
- [ ] S1 regression test (one compaction ⇒ one recompress) written and red against
      current code, then green after S1.
