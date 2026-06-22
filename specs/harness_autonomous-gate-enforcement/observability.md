# Observability: harness_autonomous-gate-enforcement

## Events

- `autonomous.gate.suspended` — emitted when the policy gate or an
  `awaiting_approval` handback suspends the loop. Fields: `sessionID`, `kind`,
  `stopReason`, `source` (`policy` | `handback`), `todoId`.
- `autonomous.gate.cleared` — emitted on user approval that releases a suspend.
  Fields: `sessionID`, `kind`, `approvedBy`.
- `paralysis.gate.deferred` — emitted when the paralysis detector exempts a turn
  because non-progress was gate-induced (DD-4). Fields: `sessionID`, `reason`.

## Logs

- `log.info("autonomous-gate: suspend", { sessionID, kind, stopReason, source })`
  at the enforcement site (workflow-runner `planAutonomousNextAction`).
- `log.info("autonomous-gate: cleared", { sessionID, kind })` on resume.
- `log.info("paralysis-defer: gate-induced non-progress, skipping ladder", { sessionID, reason })`
  at the paralysis runloop (prompt.ts).
- Existing `log.warn("paralysis-break: …")` stays — it must now NOT fire for
  gate-induced turns.

## Metrics

- `autonomous_gate_suspends_total{source}` — suspends by policy vs handback.
- `autonomous_gate_clear_latency_seconds` — time from suspend to user approval.
- `paralysis_breaks_total` — should DROP after this change (false halts removed);
  watch for it trending to ~0 for gate-class sessions while remaining non-zero
  for genuine no-gate spins.

## Alerts

- Spike in `paralysis_breaks_total` after rollout → DD-4 deferral may be missing a
  gate signal; investigate which detector fired.
- `autonomous_gate_suspends_total` near zero while approval-class work occurs →
  gate may have regressed to dead config (DD-1 enforcement not reached).

## Verification signal

The definitive success signal: replay the original stuck session's shape (a doc
todo whose text contains "architecture") under autonomous mode → the loop
completes the bookkeeping with NO suspend and NO `ParalysisDetectedError`; and a
genuinely gated step (`destructive`) → a single clean `autonomous.gate.suspended`
event, no paralysis break.
