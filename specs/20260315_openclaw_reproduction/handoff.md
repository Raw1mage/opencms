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

## Current State (2026-03-16)

- **Phase 0** (Consolidation & Benchmark): done
- **Phase 1** (Kill-switch Backend): done — 10/10 tasks complete, 13 tests passing
- **Phase 2** (Kill-switch UI): **done** — DD-1 resolved (SSE), Web Admin UI + TUI integration complete, 27 tests passing
- **Phase 3** (Kill-switch Infra): **done** — Redis pub/sub transport + MinIO/S3 snapshot backend implemented, 34 tests passing
- **Phase 4** (Security & Ops): **done** — security sign-off approved (2026-03-16), E2E tests (5), runbook delivered, 39 tests passing
- **Phase 5A** (Plan-trusting Continuation): **done** — isPlanTrusting() + max_continuous_rounds bypass + smart-runner short-circuit + tasks.md integrity exemption, 84 tests passing
- **Phase 5B** (Multi-source Trigger): pending
- **Phase 6** (Lane-aware Queue): pending
- **Deferred**: isolated jobs, heartbeat, daemon lifecycle

## Stop Gates In Force

1. ~~**No production API without security sign-off**~~ — **CLEARED** (2026-03-16, approved by project owner)
2. **No build beyond Trigger + Queue** without explicit user approval for Phases 5-6
3. **No deferred slices** (D.1-D.3) without explicit approval to enter build
4. **No silent fallback** or implicit authority recovery in any implementation
5. **No multi-authority plan drift** — if a new sibling plan is needed, user must explicitly approve
6. **Preserve gate semantics** — trigger/queue abstraction must not break approved mission / approval / decision gates

## Build Entry Recommendation

- **Next**: Phase 5B — Multi-source Trigger (tasks 5B.1 → 5B.5)
- **Then**: Phase 6 — Lane-aware Run Queue (tasks 6.1 → 6.5)
- Kill-switch Phases 1-4 fully delivered; control plane stable for trigger abstraction
- Phase 5A plan-trusting mode delivered; root cause of 40+ hour autonomous runner failure identified and fixed

## Resolved Design Decisions

| ID | Decision | Resolution | Rationale |
|----|----------|------------|-----------|
| DD-1 | Real-time status push mechanism | **SSE** | Codebase 100% SSE-native（streamSSE from Hono），zero WebSocket infrastructure。複用現有 Bus → SSE → event-reducer pipeline |

## Pending Design Decisions

| ID | Decision | Blocker For | Options |
|----|----------|-------------|---------|
| DD-2 | MFA integration approach | Task 4.1 | 複用現有系統 vs 新建 |
| DD-3 | Snapshot timing vs hard-kill window | Task 4.2 | 固定 soft_timeout vs 動態延展 |

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
- [x] Phase 3 delivered and verified — Redis transport + MinIO snapshot, 34 tests passing
- [x] Phase 4 security sign-off obtained — APPROVED (2026-03-16)
- [x] Phase 5A plan-trusting continuation mode delivered — 84 tests passing

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Generate a validation checklist derived from `tasks.md`, runtime todo outcomes, implementation results, and executed validations.
- Report requirement coverage, partial fulfillment, deferred items, and remaining gaps as concise review output.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.
