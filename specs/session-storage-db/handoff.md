# Handoff: session-storage-db

## Execution Contract

This spec is in `planned` state and ready for `implementing`. The build agent (or human operator) executes `tasks.md` phase by phase per `plan-builder §16` execution discipline. Each phase commits atomically with its tests passing.

**Scope owner**: this spec covers only the `<storage-root>/session/<sid>/` namespace. Sibling namespaces (`session_diff/`, `shared_context/`, `todo/`, `session_runtime_event/`) are out of scope and continue to use their existing storage. If a future spec wants to migrate them too, it is a separate amend / extend cycle on this spec or a sibling one.

**Authoritative artifacts**:
- `proposal.md` — why, scope, DR contract
- `spec.md` — behavioral requirements (GIVEN/WHEN/THEN)
- `design.md` — DD-1 through DD-14 decisions
- `data-schema.json` — SQLite v1 schema
- `c4.json` / `sequence.json` / `idef0.json` / `grafcet.json` — structural / runtime / functional / state models
- `errors.md` — error catalogue
- `observability.md` — Bus events, metrics, logs
- `tasks.md` — canonical phased execution checklist

**No silent fallback** (AGENTS.md rule 1) is the load-bearing invariant. Any error path that re-reads from a deleted legacy directory or swallows a SQLite error is a contract violation.

**Per-task ritual** (plan-builder §16.3): mark `tasks.md` checkbox immediately after each task, run `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/session-storage-db/`, update TodoWrite, then continue. Do not batch checkbox toggles.

**Phase rollover** (plan-builder §16.5): write a phase summary into `docs/events/event_<YYYYMMDD>_session-storage-db_phase<N>.md` at each phase boundary. Then immediately materialize the next phase's items into TodoWrite and continue (no user prompt required for plain phase rollover).

## Required Reads

Before starting any task in any phase, the executor must read:

1. `proposal.md` (full)
2. `spec.md § Requirements` for the requirement-set the current task touches
3. `design.md § Decisions` for the DDs cross-referenced by the current task
4. `data-schema.json` if the task touches storage I/O
5. `c4.json` for the component(s) the task touches
6. `sequence.json` for the runtime scenario(s) the task implements
7. `errors.md` for any error code the task introduces or consumes
8. `observability.md` for any Bus event / metric / log the task emits

Phase-specific deeper reads:

- Phase 2 (SQLite store): full `data-schema.json`; current `message-v2.ts` `stream` / `parts` / `get` for shape compatibility
- Phase 3 (Router): full `sequence.json` scenarios P5 (legacy fallback) and P6 (corruption)
- Phase 5 (Dreaming): `grafcet.json` step-by-step lifecycle; DR-4 in `proposal.md`
- Phase 8 (Hardening): all DR scenarios in `spec.md § Disaster resilience matches DR-1 through DR-5`

## Stop Gates In Force

The executor pauses and asks (per plan-builder §16.5 legitimate stop gates) when any of the following triggers:

- **Approval — destructive cleanup**: before deleting a legacy `<sid>/` directory in production (Phase 5 task 5.2's final delete step). First-time execution requires explicit user confirmation. Subsequent runs (after user approves "go ahead and migrate everything") proceed without re-asking.
- **Approval — schema migration in production**: before running any `MigrationRunner.runForward(N → N+1)` against existing user data on the daemon's primary store. Test fixtures are exempt. (DR-5 / R-5)
- **External blocker — bun:sqlite native binding missing**: if the executor's environment cannot load `bun:sqlite`, halt; this is an environment configuration issue.
- **External blocker — performance regression**: if Phase 4.5 / 8.7 benchmarks show < 50% improvement (target was ≥ 70%), pause and surface for review before proceeding to dreaming-mode rollout.
- **Drift — sync warning escalates**: if `plan-sync.ts` reports drift requiring `extend` (new requirement) or `refactor` (architecture invalidation), halt the current phase and run the appropriate `plan-promote --mode <mode>` cycle.
- **Drift — schema breaks data-schema.json**: if implementation reveals a needed table/column not in `data-schema.json`, halt; run `--mode amend` to add the column with a `[SUPERSEDED]` marker on any prior decision and a `(vN, ADDED)` marker on the new field.
- **User interrupt** (`停` / `stop autorun` / `pause`): exit autorun mode after finishing the in-flight item; do not silently resume.

## Execution-Ready Checklist

Before promoting `planned → implementing` (i.e. checking the first box in `tasks.md`), the executor (or operator) confirms:

- [ ] All `proposal.md` revisions are reflected in `spec.md`, `design.md`, `data-schema.json`
- [ ] All eight `sequence.json` scenarios have a corresponding `tasks.md` task that implements them
- [ ] All five DR scenarios have a corresponding fault-injection test in Phase 8
- [ ] `errors.md` enumerates every thrown error type the new code may produce
- [ ] `observability.md` enumerates every Bus event, metric, and log line the new code emits
- [ ] No item in `tasks.md` is `(TODO: figure out how)` — every task has a known path
- [ ] `bun:sqlite` is verified to load in the target Bun version (run `bun --eval "import('bun:sqlite').then(m => console.log(m.Database))"`)
- [ ] Reference 2253-message session is captured (or a synthetic equivalent is generated) for Phase 4.5 / 8.7 benchmarks
- [ ] User has acknowledged R-3 (single-file blast radius) and R-1 (rsync race) as accepted residual risks for v1
- [ ] User has confirmed which environment is the first target for rollout (dev daemon? staged daemon? production daemon?)
- [ ] `tweaks.cfg` is staged with documented entries for `IDLE_THRESHOLD_MS` and `CONNECTION_IDLE_MS` per Phase 5.5

## Hand-off recipients

- **Build agent (autonomous)**: this document plus `tasks.md` is enough to execute Phase 1 → Phase 9 with phase rollovers but stops at every gate above.
- **Human operator**: same plus the right to override any stop gate verbally (`autorun` / `keep going` / explicit approval phrases).
- **plan-sync.ts**: invoked after every checkbox toggle; reports drift to `.state.json.history`.
- **beta-workflow**: not engaged for this spec — work is in-product (`packages/opencode/`) but does not require beta-worktree isolation. If a phase later needs beta isolation (e.g. running against real production data), invoke `beta-workflow` then.
