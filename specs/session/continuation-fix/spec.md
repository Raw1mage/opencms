# Spec

## Purpose

- Ensure daemon restart + session continuation is resilient to code updates, with observable failures, automatic recovery, and forward-compatible message handling.

## Requirements

### Requirement: Orphan Task Recovery

The system SHALL detect ToolParts stuck in "running" state with no live worker and transition them to "error" state on daemon startup.

#### Scenario: Daemon restart with in-flight subagent

- **GIVEN** a parent session has a ToolPart with `status: "running"` and `tool: "task"` from a previous daemon instance
- **WHEN** the daemon restarts and completes InstanceBootstrap
- **THEN** the system scans all sessions for stale "running" ToolParts, marks them as `status: "error"` with message "daemon restarted while task was in-flight", and publishes a Bus event so the parent session's UI updates

#### Scenario: Daemon restart with no in-flight tasks

- **GIVEN** no ToolParts are in "running" state
- **WHEN** the daemon restarts
- **THEN** the orphan scan completes with zero changes and does not block startup

### Requirement: Session Version Guard

The system SHALL compare session.version against Installation.VERSION on load and emit a warning when they differ.

#### Scenario: Resume session from older daemon version

- **GIVEN** a session was created with version "0.1.200"
- **WHEN** Session.get() loads it on a daemon running version "0.2.0"
- **THEN** the returned Session.Info includes `staleVersion: true` in metadata, and a log warning is emitted with both versions

#### Scenario: Resume session from same version

- **GIVEN** a session was created with the current daemon version
- **WHEN** Session.get() loads it
- **THEN** no staleVersion flag is set, no warning emitted

### Requirement: Worker Pre-Bootstrap Observability

The system SHALL log diagnostic timestamps to a file before the worker's bootstrap() call, bypassing the Bus dependency.

#### Scenario: Worker bootstrap hangs

- **GIVEN** a worker child process is spawned
- **WHEN** bootstrap() hangs and the 15-second timeout fires
- **THEN** a log file at `{dataDir}/log/worker-{pid}.log` contains timestamped entries showing the worker started and entered bootstrap, enabling post-mortem diagnosis

#### Scenario: Worker bootstrap succeeds

- **GIVEN** a worker child process is spawned
- **WHEN** bootstrap() completes normally and sends "ready"
- **THEN** the pre-bootstrap log file is cleaned up (optional) or left as audit trail

### Requirement: Tool Input Normalization

The system SHALL normalize historical tool call inputs to match current tool schemas when assembling LLM context.

#### Scenario: Old apply_patch format in history

- **GIVEN** a session's message history contains a ToolPart with `tool: "apply_patch"` and `input: { patchText: "..." }`
- **WHEN** the message history is assembled for the LLM context
- **THEN** the tool call input is transformed to `{ input: "..." }` matching the current apply_patch schema, without modifying the stored data

#### Scenario: Tool call with current format

- **GIVEN** a session's message history contains a ToolPart with `tool: "apply_patch"` and `input: { input: "..." }`
- **WHEN** the message history is assembled
- **THEN** no transformation is applied

### Requirement: Execution Identity Validation

The system SHALL validate that a session's pinned account still exists and is accessible before using it for LLM requests.

#### Scenario: Pinned account deleted after session creation

- **GIVEN** a session was pinned to account "acc_123"
- **WHEN** the session is resumed but "acc_123" no longer exists in Account storage
- **THEN** the system falls back to the current active account for the same provider, logs a warning, and updates the session's execution identity

#### Scenario: Pinned account still valid

- **GIVEN** a session was pinned to account "acc_123"
- **WHEN** the session is resumed and "acc_123" still exists
- **THEN** the pinned account is used as-is, no fallback triggered

## Acceptance Checks

- Orphan ToolParts are recovered to "error" state within 5 seconds of daemon startup
- Version mismatch produces a log entry with both old and new versions
- Worker pre-bootstrap log file is created before bootstrap() is called
- Old-format tool calls in message history are normalized in LLM context without modifying storage
- Invalid pinned account triggers graceful fallback, not 401 error
- All existing tests pass (owned-diff.test.ts, any session-related tests)
