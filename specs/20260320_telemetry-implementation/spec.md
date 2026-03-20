# Spec: Telemetry planning for A111/A112 instrumentation

## Purpose

- Align the telemetry planning artifacts with the A111 prompt-block instrumentation and A112 round/session usage telemetry requirements so builders can execute the work with minimal ambiguity.

## Requirements

### Requirement: Prompt block telemetry (A111)

The plan SHALL capture every prompt block emitted during the system prompt construction in `packages/opencode/src/session/llm.ts`, including block source/name, inject policy, injected/skipped status, estimated tokens, length, and any upstream correlation IDs.

#### Scenario: plan is reviewed before code changes

- **GIVEN** the llm prompt assembly contains `systemParts` and other blocks
- **WHEN** builders consult the plan
- **THEN** each block has documented metadata fields, implementation files, and instrumentation intentions for A111 so the future code can emit telemetry without guesswork.

### Requirement: Round/session usage telemetry (A112)

The plan SHALL document instrumentation points around finish-step/round boundaries in `processor.ts` and compaction-related boundaries in `compaction.ts`, including sessionId, roundIndex, requestId, model/provider/account metadata, token breakdowns, compaction trigger/result indicators, and cumulative session summaries.

#### Scenario: telemetry coverage is audited

- **GIVEN** a builder inspects the plan
- **WHEN** they map telemetry requirements to runtime files
- **THEN** A112 instrumentation steps clearly state which boundary events to observe and how data propagates.

### Requirement: Dedicated telemetry module and failure handling

The plan SHALL prescribe using a typed telemetry module (e.g. `session/telemetry.ts`) that receives immutable metadata, validates schema, fails fast on misuse, and never mutates prompt or round behavior even if telemetry cannot be delivered. This module is the authoritative telemetry sink for A111/A112, whereas `session/monitor.ts` sits downstream as a UI projection/consumer of those metrics and `account/monitor.ts` continues to function as the aggregate/quota monitor that may be referenced by A112 without replacing the round/session telemetry contract.

#### Scenario: schema drift occurs in future work

- **GIVEN** telemetry input validation surfaces an unexpected shape
- **WHEN** telemetry module fails fast
- **THEN** prompt/round execution continues unaffected and the failure is captured for a follow-up correction.

### Requirement: Baseline vs. after validation plan

The plan SHALL include baseline/after telemetry captures plus traceability to A111/A112, ensuring instrumentation builds can demonstrate non-regression while gathering the required data.

#### Scenario: telemetry plan is executed

- **GIVEN** baseline metrics are collected before instrumentation
- **WHEN** A111/A112 adjustments are implemented
- **THEN** builders can compare results against the defined baseline checkpoints and confirm instrumentation does not alter runtime behavior.

### Requirement: Sidebar telemetry consumption plan

The plan SHALL describe how telemetry captured by `session/telemetry.ts` will feed the existing sidebar/status-card ecosystem via `session/monitor.ts`, keeping the sidebar a consumer rather than a source of truth. This includes a card taxonomy that reuses the runner/health overview, introduces prompt telemetry card(s) for A111, defines round/session telemetry card(s) for A112, and documents any account/quota reuse card. Each card must state whether it lives in the status sidebar, the context tab, or a hybrid surface and why that placement suits the metric semantics.

#### Scenario: sidebar team consumes the telemetry plan

- **GIVEN** the telemetry data contracts for A111/A112
- **WHEN** designers build or update session sidebar cards
- **THEN** they know which data slices to read, where the cards should appear, and how the contract propagates from `session/telemetry.ts` through `session/monitor.ts` to `SessionStatusSections`/`SessionSidePanel`.

## Acceptance Checks

- A111 prompt block fields (source/name, tokens, policy) are documented alongside file/line references.
- A112 round/session data points (sessionId, indices, tokens, compaction results) map to processor/compaction boundaries.
- Validation plan describes baseline/after captures plus traceability to A111/A112 requirements.
- Sidebar card taxonomy captures runner/health reuse, prompt/round telemetry cards, and account/quota reuse, with placement rationale for status vs. context surfaces.
- UI consumption contract lists the telemetry fields exposed via `session/monitor.ts` and how `SessionStatusSections`/`SessionSidePanel` will treat them as read-only consumers.
