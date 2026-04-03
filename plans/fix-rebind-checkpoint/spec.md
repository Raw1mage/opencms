# Spec

## Purpose
- Ensure a consistent rebind experience for legacy sessions (>200 messages) without stalls or prompt cache disruption.

## Requirements

### Requirement: Defensive Truncation
The system SHALL cap history back-scanning if no checkpoint is found for overly long sessions.

#### Scenario: Rebind with 440 Messages and No Checkpoint
- **GIVEN** a session with 440 messages and NO `rebind-checkpoint-*.json` file.
- **WHEN** the session is reloaded (TUI refresh or daemon restart).
- **THEN** the system SHALL return a message set capped at 100 recent entries.
- **AND** the system SHALL prepend a synthetic context summary derived from the SharedContext.

## Acceptance Checks
- Check if `filterCompacted()` returns capped messages.
- Verify prompt builder injects `SYNTHETIC_SUMMARY` label.
