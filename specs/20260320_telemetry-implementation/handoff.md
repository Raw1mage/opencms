# Handoff

## Execution Contract

- Build/implementation agent must read `implementation-spec.md` first.
- Build/implementation agent must read `tasks.md` before coding.
- Runtime todo must be materialized from `tasks.md` before execution continues.
- Build/implementation agent must not resume from discussion memory alone when this plan package is available (A111 and A112 requirements are codified here).
- User-visible progress and decision prompts must reuse the same planner-derived todo naming and highlight the builder-first path (A111 → A112 → validation).

## Required Reads

- `proposal.md` (with A111/A112 intent, validation expectations, and fail-fast constraint)
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`

## Stop Gates In Force

- Preserve approval, decision, and blocker gates from `implementation-spec.md`.
- Return to plan mode before coding if telemetry attributes, failure handling, or validation expectations need expansion.
- Do not create a brand-new sibling plan unless the user explicitly requests it, or explicitly approves an assistant proposal to branch.
- Pay special attention to telemetry ownership boundaries (`session/telemetry.ts` as the primary sink, `session/monitor.ts` as a downstream projection/consumer of that sink, and `account/monitor.ts` as the aggregate/quota monitor) before proceeding to implementation.

## Execution-Ready Checklist

- [ ] Implementation spec is complete (A111/A112 instrumentation defined).
- [ ] Companion artifacts are aligned (proposal/spec/design/tasks/diagrams share terminology and stop gates).
- [ ] Validation plan is explicit (baseline vs. after telemetry captures documented).
- [ ] Runtime todo seed is present in `tasks.md` (A111 first, A112 second, validation third).
- [ ] Sidebar/context card taxonomy is documented (runner/health reuse, prompt telemetry cards, round/session summaries, account/quota reuse) with placement rationale for status sidebar, context tab, or hybrid surfaces.
- [ ] UI consumption contract is defined so cards read `session/monitor.ts` projections (e.g., `sync.data.session_status[sessionID].telemetry`) and never become a secondary source of truth.
- [ ] Sidebar validation checklist ensures cards only appear once telemetry instrumentation is in place and remain data consumers (data layer before UI layer).

## Sidebar / Context Consumption Blueprint

- Detail the card taxonomy that ties telemetry slices to UX surfaces: reuse the runner/health overview card, add prompt telemetry cards for A111 blocks, introduce round/session telemetry cards for A112 summaries, and consider the existing account/quota card when low quota is part of the story.
- For each card, state whether it lives in the status sidebar, context tab, or a hybrid view, and explain why that placement suits the metric semantics (e.g., quick runner prompts near the status sidebar, deep-dives inside the context tab).
- Describe the UI consumption contract: telemetry flows from `session/telemetry.ts` → `session/monitor.ts` → sync data slices → `SessionStatusSections`/`SessionSidePanel`. The sidebar must treat these slices as read-only, even when cards read telemetry-rich data such as block token breakdowns or compaction results.
- Reinforce the phased order in which implementation should proceed: backend telemetry (A111 prompt blocks, A112 rounds) must land first, then sidebar/context consumption can render the new cards, with validation dedicated to confirming cards surface telemetry data without mutating runtime state.

## Telemetry Phase Assurance

- P0: Validate telemetry contracts and capture baseline expectations before emitting instrumentation. All telemetry ownership decisions must be locked before proceeding.
- P1: Implement instrumentation readiness for prompt blocks (A111) and round/session usage (A112), project data through `session/monitor.ts`, and verify telemetry rarely fails fast without affecting runtime control.
- P2: Unlock sidebar/context rendering only once P1 projection is stable, letting UI cards consume telemetry as read-only data, with verification guarding against premature renders.

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Generate a validation checklist derived from `tasks.md`, runtime todo outcomes, implementation results, and executed validations.
- Report requirement coverage, partial fulfillment, deferred items, and remaining gaps as concise review output.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.
