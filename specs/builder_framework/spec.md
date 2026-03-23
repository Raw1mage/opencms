# Spec

## Purpose

- Define build-mode behavior so beta-sensitive execution first passes a machine-checkable quiz guard, with prompt text serving only as advisory support and broad hard-guard expansion deferred.

## Requirements

### Requirement: Builder must require quiz admission for beta-sensitive execution

The system SHALL require a structured quiz guard before beta-sensitive build-mode execution is allowed to proceed.

#### Scenario: allow build entry after correct calibration

- **GIVEN** an approved mission with `mission.beta`
- **WHEN** the system asks the admission quiz and the LLM answers every required field correctly
- **THEN** build-mode admission succeeds and execution may continue

#### Scenario: retry once after incorrect calibration

- **GIVEN** an approved mission with `mission.beta`
- **WHEN** the LLM answers any required admission field incorrectly on the first attempt
- **THEN** runtime returns explicit mismatch evidence and allows one reflection-based retry

#### Scenario: stop and ask the user after repeated incorrect calibration

- **GIVEN** an approved mission with `mission.beta`
- **WHEN** the LLM still answers any required admission field incorrectly on the allowed retry
- **THEN** runtime stops build admission and asks the user instead of continuing

### Requirement: Quiz answers must be machine-checkable against mission authority

The system SHALL validate quiz answers against authoritative mission/runtime metadata rather than freeform human interpretation.

#### Scenario: compare answer fields to mission metadata

- **GIVEN** a structured quiz response containing main repo, base branch, implementation repo, implementation branch, and docs write repo
- **WHEN** runtime evaluates the response
- **THEN** each field is compared against the canonical expected value from mission metadata or authoritative mainline context

### Requirement: Prompt text must not be the primary enforcement layer

The system SHALL keep any remaining build-mode wording minimal and non-authoritative once quiz guard exists.

#### Scenario: narration remains but authority stays in quiz evaluation

- **GIVEN** a valid continuation path after quiz admission
- **WHEN** build-mode text is generated for the model
- **THEN** the text communicates current state and stop conditions, and admission authority remains handled by quiz validation rather than workflow prose

### Requirement: Broad hard-guard expansion is deferred by default

The system SHALL treat additional rule-based hard guards as deferred follow-up unless quiz validation exposes a concrete remaining failure mode.

#### Scenario: defer rule-engine expansion after successful quiz coverage

- **GIVEN** quiz guard validation shows high-confidence behavior alignment
- **WHEN** no concrete residual failure requires downstream rule-based enforcement
- **THEN** the system does not expand into a broad hard-guard matrix in this slice

## Acceptance Checks

- Correct quiz answers admit beta-sensitive build-mode entry.
- First incorrect quiz answers produce field-level mismatch evidence and one reflection-based retry.
- Repeated incorrect quiz answers stop build admission and ask the user.
- Remaining build-mode text is advisory/minimal rather than pseudo-enforcement.
- The plan records hard-guard expansion as deferred rather than silently dropped.
