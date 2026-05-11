# Spec

## Purpose

Restore the slow-first ordering invariant inside the codex upstream-wire bundles. `user.system` per-turn addenda must not invalidate the static developer bundle prefix.

## Requirements

### Requirement: opencode_agent_instructions Fragment Replaced By Two
The system SHALL replace the single `opencode_agent_instructions` fragment with two fragment producers: `opencode_agent_persona` (developer-role, body = `agent.prompt`) and `opencode_user_system_addenda` (user-role, body = `user.system`).

#### Scenario: Both producers exposed via fragments registry
- **GIVEN** opencode codex provider builds a turn
- **WHEN** the fragment registry is enumerated
- **THEN** the registry contains `opencode_agent_persona` AND `opencode_user_system_addenda`
- **AND** the registry does NOT contain `opencode_agent_instructions`

### Requirement: Persona Fragment Emitted In Developer Bundle
The system SHALL emit `opencode_agent_persona` in the developer bundle at the position immediately after the `opencode_protocol` fragment.

#### Scenario: Developer bundle byte-stable when only user.system changes
- **GIVEN** turn N has empty `user.system` and turn N+1 has non-empty `user.system` mid-session (lazy catalog activation)
- **WHEN** both outgoing developer bundles are captured
- **THEN** developer bundle text is byte-identical across the two turns
- **AND** the SHA hash of `developerBundle.text` is identical

### Requirement: Addenda Fragment Emitted At Tail Of User Bundle When Non-Empty
The system SHALL emit `opencode_user_system_addenda` at the end of the user bundle, after `environment_context`, when `user.system` joined text is non-empty. When `user.system` is empty, the system SHALL omit the fragment entirely.

#### Scenario: Empty user.system → fragment absent
- **GIVEN** turn with `user.system = []`
- **WHEN** user bundle is captured
- **THEN** user bundle fragment ids = `["agents_md:global", "agents_md:project", "environment_context"]`
- **AND** the user bundle text ends with `</environment_context>` (no trailing addenda wrapper)

#### Scenario: Non-empty user.system → fragment at tail
- **GIVEN** turn with `user.system = ["[QUOTA-LOW] this is your final turn..."]`
- **WHEN** user bundle is captured
- **THEN** user bundle fragment ids end with `"opencode_user_system_addenda"`
- **AND** the addenda text appears AFTER `</environment_context>` in the user bundle body

### Requirement: Telemetry Reflects New Fragment Ids
The system SHALL emit `prompt.bundle.assembled` log + `bus.llm.prompt.telemetry` event with fragment id lists that contain `opencode_agent_persona` (always present in developer bundle) and `opencode_user_system_addenda` (only when non-empty).

#### Scenario: Telemetry on a typical turn (empty user.system)
- **GIVEN** turn with empty `user.system`
- **WHEN** prompt.bundle.assembled fires
- **THEN** developerBundle.fragmentIds contains `opencode_agent_persona`
- **AND** userBundle.fragmentIds does NOT contain `opencode_user_system_addenda`

### Requirement: Upstream-Sourced Fragments Unchanged
The system SHALL preserve byte-for-byte body shape of upstream-sourced fragments (`role_identity`, `opencode_protocol`, `agents_md:global`, `agents_md:project`, `environment_context`).

#### Scenario: Existing fragments untouched
- **GIVEN** all upstream-sourced fragment producers
- **WHEN** invoked with the same inputs as before this spec
- **THEN** their body outputs are byte-identical to pre-spec behavior

### Requirement: No Silent Fallback On Producer Error
The system SHALL surface fragment producer errors to the caller and refuse the turn; it MUST NOT fall back to the old combined `opencode_agent_instructions` fragment shape.

#### Scenario: Producer throws → request aborted
- **GIVEN** a producer throws during fragment build
- **WHEN** the bundle assembler runs
- **THEN** the error propagates to the LLM stream caller
- **AND** the outgoing request is not sent

## Acceptance Checks

- [ ] `opencode_agent_persona` producer exists at `packages/opencode/src/session/context-fragments/opencode-agent-persona.ts`.
- [ ] `opencode_user_system_addenda` producer exists at `packages/opencode/src/session/context-fragments/opencode-user-system-addenda.ts`.
- [ ] `opencode-agent-instructions.ts` is deleted (or its export removed from `index.ts` and the file kept only if needed for back-compat with a feature flag).
- [ ] `llm.ts` codex upstream-wire path replaces the single fragment build with two builds at distinct bundle positions.
- [ ] On a turn with empty `user.system`, developer bundle text hash equals the developer bundle text hash from a prior turn with also-empty `user.system` (assuming agent / model unchanged).
- [ ] On a turn with non-empty `user.system`, developer bundle text hash equals the prior empty-`user.system` turn's hash; only user bundle differs.
- [ ] User bundle text ends with `</environment_context>` when `user.system` is empty; ends with the addenda fragment otherwise.
- [ ] `prompt.bundle.assembled` telemetry lists `opencode_agent_persona` and (conditionally) `opencode_user_system_addenda`.
- [ ] No upstream-sourced fragment producer's output bytes changed.
- [ ] Unit tests cover both empty and non-empty addenda paths, plus the byte-stability assertion.
