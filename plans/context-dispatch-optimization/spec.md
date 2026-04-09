# Spec: Context Dispatch Optimization

## Purpose

- 定義 Codex fork dispatch 的可觀察行為
- 定義 Checkpoint-based dispatch 的 fallback 行為

## Requirements

### Requirement: Codex Fork Dispatch

Codex subagent dispatch SHALL use parent's previousResponseId as the conversation fork base, avoiding full parent history resend.

#### Scenario: Dispatch subagent when parent has valid Codex responseId

- **GIVEN** a parent session using Codex provider with a captured `responseId = R_N`
- **WHEN** `task()` dispatches a subagent
- **THEN** child session's initial `codexSessionState` SHALL be seeded with `{ responseId: R_N }`
- **AND** child's first LLM call SHALL inject `previousResponseId = R_N`
- **AND** child's `parentMessagePrefix` injection SHALL be skipped for this first call

#### Scenario: Dispatch subagent when parent has no Codex responseId

- **GIVEN** a parent session using Codex provider with no captured responseId
- **WHEN** `task()` dispatches a subagent
- **THEN** child SHALL fall back to checkpoint-based dispatch or full history (existing behavior)

#### Scenario: Non-Codex provider dispatch is unaffected

- **GIVEN** a parent session using Anthropic or Gemini provider
- **WHEN** `task()` dispatches a subagent
- **THEN** dispatch behavior SHALL remain unchanged (stable prefix, content-based cache)

---

### Requirement: Checkpoint-Based Dispatch

When dispatching a subagent, the system SHALL use a rebind checkpoint as the context base if one exists, reducing first-round token cost.

#### Scenario: Checkpoint exists at dispatch time

- **GIVEN** a non-Codex parent session with a saved rebind checkpoint covering messages 1–N
- **WHEN** `task()` dispatches a subagent
- **THEN** child's parentMessagePrefix SHALL be assembled as `[checkpoint summary | messages after lastMessageId]`
- **AND** total parent prefix token count SHALL be measurably smaller than full history

#### Scenario: No checkpoint exists at dispatch time

- **GIVEN** a parent session with no checkpoint on disk
- **WHEN** `task()` dispatches a subagent
- **THEN** child SHALL fall back to full parent history (existing V2 behavior)

## Acceptance Checks

- Codex subagent first-round provider payload does NOT contain parent history messages when fork is active (`[WS-REQUEST]` log shows only separator + task).
- Checkpoint-based dispatch: child first-round token count < 10K when checkpoint exists vs ~100K without.
- Non-Codex provider dispatch behavior is unchanged (regression test: stable prefix still prepended).
