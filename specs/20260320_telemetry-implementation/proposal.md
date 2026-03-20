# Proposal: Telemetry planning for A111/A112 instrumentation

## Why

- Build an execution-ready plan that captures prompt-block (A111) and round/session usage (A112) telemetry without prematurely touching runtime code.
- Ensure future builders know which files, data points, and validation gates need coverage before any telemetry code is merged.

## Original Requirement Wording (Baseline)

- "Instrument prompt blocks around systemParts/system construction in `llm.ts` and track block source/name, injected/skipped status, estimated tokens, length, and correlation IDs."
- "Instrument finish-step/round boundaries in `processor.ts` and compaction boundaries in `compaction.ts` with sessionId, roundIndex, requestId, model/provider/account, token breakdowns, compaction trigger/result, and cumulative session summary."
- "Prefer a dedicated typed telemetry module (e.g. `session/telemetry.ts`) rather than polluting prompt assembly logic."

## Requirement Revision History

- 2026-03-21 Planning refresh: elevated validation/traceability expectations, clarified that telemetry failures must not mutate prompt/round behavior and that schema misuse should fail fast.

## Effective Requirement Description

1. Deliver a telemetry-focused proposal/spec/design/tasks package that clearly traces A111 prompt-block instrumentation and A112 round/session usage telemetry to the required files and data points.
2. Define a validation strategy with baseline/after comparisons plus migration validation such that telemetry success does not alter the core prompt or round behaviors.
3. Provide an execution-ready handoff (tasks + diagrams) so builders can implement the telemetry module with knowledge of stop gates, failure modes, and traceability to A111/A112.

## Scope

### IN

- Planning artifacts under `specs/20260320_telemetry-implementation/*`, including proposal, spec, design, tasks, handoff, implementation-spec, IDEF0, and GRAFCET.
- Collating intents from `specs/20260320_llm` materials and the listed runtime landing zones to ensure instrumentation can be mapped to real files.
- Capturing requirements for dedicated telemetry module instrumentation surface without changing runtime code.
- Adding an information-architecture plan for telemetry-fed sidebar/context cards that consume `session/telemetry.ts` output (via `session/monitor.ts`) instead of becoming a secondary source of truth.

### OUT

- Any product code modifications or telemetry module implementations (those are for future execution slices).
- Side quests beyond A111/A112 instrumentation planning (e.g., UI dashboards, summary compaction fixes).

## Non-Goals

- Writing or validating TypeScript telemetry code.
- Expanding the plan beyond the two telemetry slices (A111 prompt block, A112 round/session usage).

## Constraints

- Telemetry must not change prompt or round behavior; instrumentation reads only and fails fast on schema misuse.
- Validation must demonstrate baseline vs. after instrumentation capture without requiring silent fallbacks.
- Documentation must stay concise, traceable, and aligned with existing planning conventions (trace to A111/A112).

## What Changes

- Fill each plan artifact with concrete telemetry content (proposal, spec, design, tasks, handoff, implementation-spec, IDEF0, GRAFCET).
- Embed requirements, stop gates, and validation steps specific to A111/A112 instrumentation needs.

## Capabilities

### New Capabilities

- Execution-ready telemetry planning: builders receive a complete view of data fields, files, and validation needed for A111/A112.

### Modified Capabilities

- Planning practice: existing spec/design structure now includes explicit traceability to telemetry requirements plus benchmark/validation gating.

## Impact

- Guides implementation of telemetry hooks in `packages/opencode/src/session/{llm.ts,processor.ts,compaction.ts,prompt.ts,telemetry.ts}` (future code) while clarifying that `session/telemetry.ts` is the authoritative instrumentation sink, `session/monitor.ts` is a downstream consumer/UI projection, and `account/monitor.ts` remains the existing aggregate/quota monitor that may be reused by A112 but not the round/session contract.
- Sets plan-mode expectations for builders about baseline vs. after comparisons, diagram traceability, and validation checklists.
- Ensures sidebar/context planning knows which telemetry slices power the existing runner/health cards and the new prompt/round summary cards so UI work remains a consumer layer in the same plan.
