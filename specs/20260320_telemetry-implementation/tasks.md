# Tasks

## 1. Requirements & Context Alignment

- [ ] 1.1 Confirm plan references A111/A112 intent from `specs/20260320_llm/implementation-spec.md` and `handoff.md`.
- [ ] 1.2 Map each telemetry data field to the listed landing zones (`llm.ts`, `processor.ts`, `compaction.ts`, `prompt.ts`, `telemetry.ts`) and clarify the downstream projection role of `session/monitor.ts` as a UI consumer while keeping `account/monitor.ts` focused on aggregate/quota responsibilities.
- [ ] 1.3 Verify dedicated telemetry module decision (`session/telemetry.ts`) is documented with validation/failure expectations.

## 2. Execution-ready Planning

- [ ] 2.1 Author implementation-spec phases that break A111/A112 instrumentation and telemetry validation into discrete slices.
- [ ] 2.2 Populate IDEF0/GRAFCET with nodes/steps reflecting telemetry preparation, baseline capture, instrumentation sequencing, and validation/traceability outputs.
- [ ] 2.3 Clarify stop gates ensuring telemetry failures cannot mutate runtime behavior and that schema misuse fails fast.

## 3. Validation Alignment

- [ ] 3.1 Document baseline vs. after capture expectations, including representative session scenarios and benchmarks for A111/A112 reporting.
- [ ] 3.2 Specify telemetry verification commands or log checks (e.g., inspect baseline telemetry output) for future builders.
- [ ] 3.3 Record acceptance criteria traced to proposal/spec/design (A111/A112 coverage, no behavior changes, validation gates).

## 4. Handoff & Runtime Todo Seed

- [ ] 4.1 Ensure `handoff.md` lists required reads, execution contract, stop gates, and execution-ready status checkboxes tied to telemetry.
- [ ] 4.2 Provide runtime todo seed encouraging builders to materialize A111 first, then A112, specifying telemetry validation expectations.
- [ ] 4.3 Confirm diagrams, tasks, and specs share consistent naming/traceability for future automation (A111 vs. A112 vs. validation).

## 5. Sidebar / Context Consumption Planning

- [ ] 5.1 Document the sidebar/context card taxonomy: reuse the runner/health overview, define prompt telemetry card(s) for A111, round/session telemetry card(s) for A112, and note any account/quota reuse card. State whether each card lives in the status sidebar, the context tab, or a hybrid surface, and why that placement matches the metric semantics.
- [ ] 5.2 Define the UI consumption contract so cards read the telemetry slices exposed by `session/monitor.ts` (e.g., `sync.data.session_status[sessionID].telemetry` or a dedicated `sync.data.session_telemetry[sessionID]`) without writing or inferring their own data.
- [ ] 5.3 Tie this card planning back into diagrams/tasks/handoff so builders understand the phased order (data layer first, UI consumer next) and how to validate the sidebar/context renderings once backend telemetry is live. Prioritize P2a runner/prompt, P2b round/session, and P2c account/quota sequencing in the todo flow.

## 6. Phased Planning Assurance

- [ ] 6.1 Confirm the plan explicitly reinforces the P0→P1→P2 ordering so data-layer readiness gates precedent to instrumentation readiness, which in turn gates sidebar/context rendering.
- [ ] 6.2 Trace each deliverable (document, verification, card) back to its phase to avoid premature execution (e.g., no sidebar cards before P2).
- [ ] 6.3 Validate that stop gates and dependencies list the risks for each phase and note any cross-phase handoff expectations (e.g., P1 waits on P0 baseline data, P2 waits on P1 projection stability).

<!--
Unchecked checklist items seed the runtime todo for implementation agents.
 -->
