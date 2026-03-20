# Spec: Session Context Control + Compaction Strategy Spec

## Purpose

- 定義現有 session context-control / compaction runtime 的可觀測行為基線，作為優化分析與後續實作的審核標準。

## Requirements

### Requirement: Session prompt assembly must have a traceable context pipeline

The system SHALL describe the current path from stored session messages to final `LLM.stream()` request payload, including all major prompt and message transformation stages.

#### Scenario: documenting the current runtime

- **GIVEN** the planner is building a spec for existing behavior
- **WHEN** session context control is described
- **THEN** the spec must identify the boundaries across `prompt.ts`, `message-v2.ts`, `llm.ts`, `provider/transform.ts`, and `processor.ts`

### Requirement: Compaction trigger logic must be modeled with token headroom semantics

The system SHALL document how overflow is detected, what token counters are used, and how reserved headroom differs when `model.limit.input` exists versus when it does not.

#### Scenario: analyzing compaction threshold safety

- **GIVEN** a model with context and output limits
- **WHEN** `SessionCompaction.isOverflow()` is evaluated
- **THEN** the spec must state the current usable-window formula, config overrides, and known regression coverage from tests

### Requirement: Compaction execution path must preserve summary/prune boundaries

The system SHALL describe how auto compaction creates a synthetic compaction task, generates a summary assistant message, and optionally prunes older tool outputs.

#### Scenario: following compaction end-to-end

- **GIVEN** a session crosses overflow threshold
- **WHEN** auto compaction runs
- **THEN** the spec must show where compaction is queued, how summary prompts are built, and where tool-output pruning occurs

### Requirement: Optimization analysis must separate low-risk and architecture-sensitive changes

The system SHALL produce an optimization roadmap that distinguishes quick wins from deeper refactors and explains the validation burden of each.

#### Scenario: proposing improvements

- **GIVEN** current runtime overhead has multiple possible causes
- **WHEN** optimization candidates are listed
- **THEN** each candidate must identify expected token/context benefit, affected files, and risk level

### Requirement: Runtime todo derives from planner tasks

The system SHALL treat planner `tasks.md` unchecked checklist items as the runtime todo seed.

#### Scenario: plan is approved for execution

- **GIVEN** planner artifacts are execution-ready
- **WHEN** the plan is materialized into runtime execution
- **THEN** runtime todo must be derived from `tasks.md`, not from ad hoc conversational checklists

### Requirement: Same workstream extends the same plan

The system SHALL extend the existing plan root for the same workstream instead of creating a new sibling plan by default.

#### Scenario: a new idea or bug appears within the same workstream

- **GIVEN** an existing plan already captures the active workstream
- **WHEN** follow-up scope, fixes, or design slices are added
- **THEN** the planner must update the same plan root unless the user explicitly requests or approves a new plan

### Requirement: New plans require user-approved branching

The system SHALL only create a new plan root when the user explicitly requests one, or explicitly approves the assistant's proposal to branch.

#### Scenario: assistant detects a possible branch

- **GIVEN** the assistant sees adjacent but potentially separable work
- **WHEN** user approval has not been given
- **THEN** the assistant must not create a new plan root on its own

### Requirement: Completion includes retrospective review

The system SHALL produce a post-implementation review that compares implementation results against the effective requirement description.

#### Scenario: implementation is declared complete

- **GIVEN** execution work has been finished
- **WHEN** the assistant prepares completion reporting
- **THEN** it must provide concise requirement coverage, remaining gaps, and validation evidence without exposing raw internal chain-of-thought

## Acceptance Checks

- `specs/20260320_llm/{proposal,spec,design,implementation-spec,tasks,handoff}.md` 不再保留模板 placeholder。
- 規格內容能指出至少以下控制點：prompt assembly、message conversion、provider normalization、overflow detection、compaction summary、prune。
- 規格內容明確引用 `compaction.test.ts` 中的 headroom regression 與 config schema。
- 優化分析能分成 quick wins / medium refactor / high-risk architecture changes。
