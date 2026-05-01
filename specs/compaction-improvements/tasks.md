# Tasks: compaction-improvements

## 1. Phase A — Edge cleanup foundation

- [x] 1.1 Extend provider-switched compaction chain with replay-tail fallback and tests.
- [x] 1.2 Refresh estimated input tokens after rebind attempts even when no anchor is applied.
- [x] 1.3 Add last-user/boundary guard coverage for compaction child runloop no-user-message failures.

## 2. Phase B — Context budget surfacing

- [x] 2.1 Add budget status threshold tweaks and parsing tests.
- [x] 2.2 Inject server-confirmed context budget into the last user-message envelope.
- [x] 2.3 Include budget surfacing in runtime-self-heal nudge and subagent sessions.

## 3. Phase C — Trigger inventory and codex routing

- [x] 3.1 Introduce explicit trigger inventory and predicate evaluation tests.
- [x] 3.2 Add cache-loss and stall-recovery predicates with fixpoint-safe gates.
- [x] 3.3 Refactor static kind chain into provider-aware chain resolution.
- [x] 3.4 Wire codex subscription server-side compaction priority and Mode 1 request shape.

## 4. Phase D — Big content boundary handling

- [x] 4.1 Add session-scoped attachment reference storage contract.
- [x] 4.2 Route oversized user-message attachments to reference parts.
- [x] 4.3 Route oversized subagent returns to reference previews.
- [x] 4.4 Add worker query tools for vision, file digest, and task-result drilldown.

## 5. Phase E — Telemetry, validation, and docs

- [x] 5.1 Emit compaction predicate, chain, budget, and boundary-routing telemetry.
- [x] 5.2 Run focused compaction/session tests and fix regressions.
- [x] 5.3 Sync `specs/architecture.md` and event log with final implementation evidence.
