# Handoff: openclaw_reproduction

## Execution Contract

- `openclaw_reproduction` is the single active planning authority for OpenClaw-aligned runner evolution.
- Use benchmark conclusions and implementation slices from this package together; do not bounce between older `openclaw*` packages as if they were co-equal active plans.
- `specs/20260316_kill-switch/` is the implementation detail reference for kill-switch work; authority remains here.
- Build agent must read `tasks.md` before coding; runtime todo must be materialized from `tasks.md` before execution continues.
- Build agent must not resume from discussion memory alone when this plan package is available.
- User-visible progress and decision prompts must reuse the same planner-derived todo naming.

## Required Reads

- `proposal.md` — requirement wording, revision history, effective requirements, scope
- `spec.md` — GIVEN/WHEN/THEN structured requirements for all slices
- `design.md` — architecture decisions, state model, control protocol, pending design decisions
- `implementation-spec.md` — phased execution plan with stop gates and validation
- `tasks.md` — canonical task list with completion status
- `specs/20260316_kill-switch/` — kill-switch implementation detail specs (control-protocol, rbac-hooks, snapshot-orchestration)

## Current State (2026-03-17)

- **Phase 0** (Consolidation & Benchmark): done
- **Phase 1** (Kill-switch Backend): done — 10/10 tasks complete, 13 tests passing
- **Phase 2** (Kill-switch UI): **done** — DD-1 resolved (SSE), Web Admin UI + TUI integration complete, 27 tests passing
- **Phase 3** (Kill-switch Infra): **done** — local-only transport + snapshot (redis/minio adapters removed 2026-03-17), 3 tests passing
- **Phase 4** (Security & Ops): **done** — security sign-off approved (2026-03-16), E2E tests (5), runbook delivered, 39 tests passing
- **Phase 5A** (Plan-trusting Continuation): **done** — isPlanTrusting() + max_continuous_rounds bypass + smart-runner short-circuit + tasks.md integrity exemption, 84 tests passing
- **Phase 5B** (Multi-source Trigger): **done** — RunTrigger union type (Continuation | Api), TriggerEvaluator extracted from planAutonomousNextAction(), buildApiTrigger scaffold, 83 tests passing
- **Phase 6** (Lane-aware Queue): **done** — RunQueue with 3 lanes (critical/normal/background), lane policy with concurrency caps, supervisor drain integration, 99 tests passing
- **Stage 3 D.1** (Isolated Job Sessions): **done** — types, store, session factory, lightContext, delivery, retention, run-log. 25 tests passing. Commit `a45b96cbe0`
- **Stage 3 D.2** (Heartbeat/Wakeup): **done** — schedule engine (at/every/cron), deterministic stagger, active hours, system event queue, HEARTBEAT_OK suppression, wake modes. 40 tests passing. Commit `d0f83d6272`
- **Stage 3 D.3** (Daemon Lifecycle): **done** — gateway lock, signal dispatch, drain state machine, command lanes (Main/Cron/Subagent/Nested), restart loop, generation numbers. 28 tests passing. Commit `2247dfd677`
- **D.3.10** (Retry Policy): **done** — error classification (transient/permanent), exponential backoff, one-shot vs recurring policy. 20 tests passing.

## Stop Gates In Force

1. ~~**No production API without security sign-off**~~ — **CLEARED** (2026-03-16, approved by project owner)
2. **No build beyond Trigger + Queue** without explicit user approval for Phases 5-6
3. ~~**No D.1-D.3 build** without explicit approval~~ — **CLEARED** (2026-03-17, D.1-D.3 delivered)
7. **No Stage B/C/D build** without explicit approval — specs expanded (2026-03-17), awaiting build approval
4. **No silent fallback** or implicit authority recovery in any implementation
5. **No multi-authority plan drift** — if a new sibling plan is needed, user must explicitly approve
6. **Preserve gate semantics** — trigger/queue abstraction must not break approved mission / approval / decision gates

## Build Entry Recommendation

- **All phases through Stage 3 complete** — Phases 0-6 + D.1-D.3 delivered
- **Cleanup done (2026-03-17)**: aws4fetch + ioredis removed, heartbeat integration test added
- **openclaw merged to cms** (2026-03-17) — fast-forward at `b4c6013d8f`

### Next

1. **Stage 4 (B)**: E2E Integration Verification — multi-channel boot, session isolation, kill-switch E2E, backward compat (Phases 11-14)
2. **Stage 5 (C)**: Webapp/Operator Surface — channel management UI, health dashboard, session picker (Phases 15-17)
3. **Stage 6 (D)**: Future Channel Extensions — quota, cron scope, migration, RBAC (Phases 18-21)

### Dependency Chain

```
Stage 4 (B: E2E Verification) → independent, ship first
Stage 5 (C: Operator Surface) → depends on Stage 4 passing
Stage 6 (D: Extensions) → depends on Stage 5 for UI, can start D.4/D.5 in parallel with C
```

## Resolved Design Decisions

| ID | Decision | Resolution | Rationale |
|----|----------|------------|-----------|
| DD-1 | Real-time status push mechanism | **SSE** | Codebase 100% SSE-native（streamSSE from Hono），zero WebSocket infrastructure。複用現有 Bus → SSE → event-reducer pipeline |

## Pending Design Decisions

Stage B/C/D design decisions pending — see design.md DD-13 to DD-16.

| ID | Decision | Resolution | Rationale |
|----|----------|------------|-----------|
| DD-2 | MFA integration approach | **Reuse existing** | Phase 4 security sign-off confirmed existing MFA system sufficient |
| DD-3 | Snapshot timing vs hard-kill window | **Fixed soft_timeout** | Phase 4 E2E tests validated fixed-window approach; dynamic extension deferred as non-critical |

## Historical Note

- This consolidated plan supersedes the earlier split between benchmark-only planning and scheduler-substrate planning.
- Related completed specs (all tasks done, reference-only):
  - `specs/20260313_autorunner-spec-execution-runner/` — runner execution contract
  - `specs/20260315_openspec-like-planner/` — planner hardening + web-monitor-restart-control
  - `specs/20260315_autorunner/` — planner/runner/bootstrap contract rewrite
  - `specs/20260315_easier_plan_mode/` — plan/build mode semantics

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in `tasks.md`
- [x] Phase 0-1 delivered and verified
- [x] Phase 2 design decision (DD-1) resolved — SSE
- [x] Phase 2 delivered and verified — 27 tests passing
- [x] Phase 3 delivered and verified — local-only (redis/minio removed), 3 tests passing
- [x] Phase 4 security sign-off obtained — APPROVED (2026-03-16)
- [x] Phase 5A plan-trusting continuation mode delivered — 84 tests passing
- [x] Phase 5B multi-source trigger delivered — RunTrigger + TriggerEvaluator + API scaffold, 83 tests passing
- [x] Phase 6 lane-aware run queue delivered — RunQueue + lane policy + supervisor integration, 99 tests passing
- [x] Stage 3 (D.1-D.3) specs expanded — IDEF0 (5 files) + GRAFCET (4 files) + 24 sub-tasks + DD-7 to DD-12
- [x] Stage 3 D.1 build complete — 25 tests passing (commit `a45b96cbe0`)
- [x] Stage 3 D.2 build complete — 40 tests passing (commit `d0f83d6272`)
- [x] Stage 3 D.3 build complete (except D.3.10) — 28 tests passing (commit `2247dfd677`)
- [x] D.3.10 retry policy implemented — 20 tests passing
- [x] aws4fetch + ioredis removed — dependencies and dead code paths deleted (2026-03-17)
- [x] heartbeat integration test — real imports, 7 tests (2026-03-17)
- [x] openclaw branch merged to cms — fast-forward at `b4c6013d8f` (2026-03-17)
- [x] Stage B/C/D specs expanded — IDEF0 (A6-A8 L1 + A61/A71/A81 L2, 7 files) + GRAFCET (A0 updated + A6/A7/A8, 4 files) + 40 new tasks + DD-13 to DD-16
- [ ] Stage 4 (B) E2E integration verification
- [ ] Stage 5 (C) webapp/operator surface
- [ ] Stage 6 (D) future channel extensions

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Generate a validation checklist derived from `tasks.md`, runtime todo outcomes, implementation results, and executed validations.
- Report requirement coverage, partial fulfillment, deferred items, and remaining gaps as concise review output.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.
