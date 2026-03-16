# Handoff: Scheduler Persistence + Daemon Channels

## Execution Contract

- This spec is the single planning authority for scheduler persistence and daemon channel work.
- Build agent must read `implementation-spec.md` first, then companion artifacts.
- Build agent must materialize runtime todo from `tasks.md` before coding.
- Implementation happens in `~/projects/opencode-runner` on branch `scheduler-daemon`.
- Final merge target: `~/projects/opencode` branch `cms`.

## Required Reads

- `implementation-spec.md` — phased execution plan with stop gates
- `proposal.md` — why, scope, constraints
- `spec.md` — GIVEN/WHEN/THEN behavioral requirements
- `design.md` — architecture decisions (DD-13 to DD-17), data flow, critical files
- `tasks.md` — canonical task list with completion status
- `diagrams/` — IDEF0 functional decomposition + GRAFCET state machines (see below)

## Current State (2026-03-17)

- **Phase 1** (Scheduler Recovery): not started
- **Phase 2** (Channel Model): not started
- **Phase 3** (Per-channel Lanes): not started
- **Phase 4** (Channel Kill-switch): not started
- **Phase 5** (API + Health): not started

### Prerequisites met

- CronStore write-through persistence verified (jobs.json includes CronJobState)
- RetryPolicy module available for backoff overlay
- Schedule module available for nextRunAtMs computation
- Daemon lifecycle (D.3) fully implemented — gateway lock, signals, drain, lanes, restart
- Kill-switch backend with emergency abort-all endpoint delivered

## Stop Gates In Force

1. **Phase 1 must pass recovery tests** before Phase 2 — scheduler recovery is a prerequisite for all channel work
2. **Channel schema (DD-14, DD-17) needs user approval** before Phase 2 implementation — per-file JSON, default channel bootstrap
3. **No breaking changes to existing kill-switch** — emergency abort-all must continue working
4. **No new external dependencies**

## Build Entry Recommendation

Start with **Phase 1** (Scheduler Recovery) — it's self-contained, has clear test criteria, and doesn't depend on channel work. Phase 1 can ship independently even if channel work is deferred.

### Dependency chain

```
Phase 1 (Recovery) → independent, ship first
Phase 2 (Channel Model) → depends on Phase 1 passing
Phase 3 (Per-channel Lanes) → depends on Phase 2
Phase 4 (Channel Kill-switch) → depends on Phase 2 + Phase 3
Phase 5 (API + Health) → depends on Phase 2 + Phase 3 + Phase 4
```

### Branch setup

```bash
cd ~/projects/opencode-runner
git fetch opencode cms
git checkout -b scheduler-daemon opencode/cms
```

## Resolved Design Decisions

| ID | Decision | Resolution | Rationale |
|----|----------|------------|-----------|
| DD-13 | Stale schedule catchup | **skip-to-next** | Catchup 288 missed runs wastes tokens; skip-to-next is safe |
| DD-14 | Channel persistence | **per-file JSON** | Consistent with CronStore; avoids write contention |
| DD-15 | Lane namespace | **channel:lane composite key** | Minimal change to Lanes module |
| DD-16 | Kill-switch scope | **optional channelId** | Backward compat; global kill still one-key |
| DD-17 | Default channel | **auto-bootstrap on empty** | Zero-config for non-channel users |

## Pending Design Decisions

None — all design decisions pre-resolved.

## IDEF0 / GRAFCET Diagrams

Three-level decomposition in `diagrams/`:

### IDEF0 (9 files)

| File | Level | Scope |
|------|-------|-------|
| `opencode_a0_idef0.json` | L0 | A0 context → A1-A5 |
| `opencode_a1_idef0.json` | L1 | A1 → A11-A14 (Scheduler Recovery) |
| `opencode_a2_idef0.json` | L1 | A2 → A21-A24 (Channel Lifecycle) |
| `opencode_a3_idef0.json` | L1 | A3 → A31-A34 (Lane Allocation) |
| `opencode_a4_idef0.json` | L1 | A4 → A41-A43 (Kill-Switch Scope) |
| `opencode_a5_idef0.json` | L1 | A5 → A51-A54 (API + Health) |
| `opencode_a12_idef0.json` | L2 | A12 → A121-A123 (Stale Detection) |
| `opencode_a13_idef0.json` | L2 | A13 → A131-A133 (Timing Recomputation) |
| `opencode_a22_idef0.json` | L2 | A22 → A221-A223 (Channel Persistence) |

### GRAFCET (5 files)

| File | State Machine |
|------|---------------|
| `opencode_a0_grafcet.json` | Top-level boot → recovery → channels → lanes ∥ kill-switch → API → loop |
| `opencode_a1_grafcet.json` | Scheduler recovery: load → detect stale → recompute/preserve → re-register |
| `opencode_a2_grafcet.json` | Channel lifecycle: bootstrap / validate / remove → persist → emit |
| `opencode_a3_grafcet.json` | Lane allocation: namespace → cap check → enqueue/wait → execute → release |
| `opencode_a4_grafcet.json` | Kill-switch: assert / abort channel / global override → audit |

### Traceability

- Every GRAFCET `ModuleRef` maps to an IDEF0 activity ID
- A0 GRAFCET references A1-A5 as `sub_grafcet` steps
- A1 GRAFCET references A11-A14 leaf activities
- L2 IDEF0 (A12, A13, A22) provides deeper functional decomposition for critical paths

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
- [x] Prerequisites met (CronStore, RetryPolicy, Schedule, Daemon D.3, Kill-switch)
- [x] IDEF0 functional decomposition (3 levels, 9 files)
- [x] GRAFCET state machines (5 files, traceable to IDEF0)
- [ ] Phase 1 build started
- [ ] Phase 1 tests passing
- [ ] Phase 2 channel schema approved
- [ ] Phase 2 build started
- [ ] Full integration verified

## Completion / Retrospective Contract

- Review implementation against spec.md acceptance checks.
- Validate that default channel behavior is identical to pre-channel behavior.
- Verify scheduler recovery handles all stale scenarios (one-shot, recurring, backoff).
- Report coverage of tasks.md checklist items.
