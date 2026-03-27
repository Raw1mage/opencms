# Design

## Context

- Durable cron scheduling in OpenCode has evolved across multiple artifacts: the older `specs/scheduler-channels/` package, recent runtime fixes in cron code, and two 2026-03-27 debug events that proved minute-level cadence and daemon lifecycle wiring both mattered.
- The immediate design problem is not “how to invent durability” but “how to normalize current truth into one active contract so the next build slice targets only the remaining uncertainty.”

## Goals / Non-Goals

**Goals:**

- Capture the current durable scheduler baseline accurately.
- Limit next implementation slices to validation and hardening work with clear evidence requirements.

**Non-Goals:**

- Rebuild the channel architecture plan.
- Introduce silent fallback paths or catch-up hacks for missing runtime execution.

## Decisions

- Treat `specs/scheduler-channels/` as historical architecture context, but treat 2026-03-27 event evidence as the current-state baseline for scheduler durability behavior.
- Scope this plan to cron durability consolidation + hardening, not to multi-channel daemon expansion; this keeps the plan aligned with the user's chosen「收斂現況」 posture.
- Keep validation two-layered: targeted unit/regression tests for store/heartbeat/lifecycle slices, plus live operator evidence in the real daemon path.

## Data / State / Control Flow

- Cron job definitions and state persist in `CronStore`; daemon boot or real `listenUnix()` startup must recover schedules and register heartbeat before jobs can produce runtime evidence.
- Operator-visible proof flows through run-log JSONL plus `/system/tasks` execution history; both surfaces must move together when runtime wiring is healthy.
- Planning authority flows from docs/specs/events into this active plan, then back into a new event log and architecture verification after build completion.

## Risks / Trade-offs

- Historical spec drift -> mitigate by explicitly naming which previous artifacts are still authoritative for this slice and which are only context.
- Over-scoping into channel architecture -> mitigate by keeping channel work out-of-scope unless the user explicitly reopens it.
- Test-only confidence without live runtime proof -> mitigate by requiring daemon-backed smoke validation in addition to unit tests.

## Critical Files

- `packages/opencode/src/cron/heartbeat.ts`
- `packages/opencode/src/cron/store.ts`
- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/daemon/index.ts`
- `packages/opencode/src/server/routes/cron.ts`
- `docs/events/event_20260327_cron_not_running_on_schedule.md`
- `docs/events/event_20260327_cron_no_execution_log_runtime_lifecycle.md`
