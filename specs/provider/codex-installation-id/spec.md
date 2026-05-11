# Spec

## Purpose

Make every opencode codex Responses turn carry the same stable per-install identity that upstream codex CLI sends, so ChatGPT backend can route prefix-cache lineage and treat us as a returning client rather than a fresh anonymous one.

## Requirements

### Requirement: Per-Install UUID Persisted On Disk
The system SHALL persist a v4 UUID at `${OPENCODE_DATA_HOME}/codex-installation-id` (default `~/.config/opencode/codex-installation-id`), mode 0644, on first launch and reuse it forever after across all opencode processes sharing the same data home.

#### Scenario: First launch generates and persists
- **GIVEN** the file `${OPENCODE_DATA_HOME}/codex-installation-id` does not exist
- **WHEN** codex auth bootstrap calls `resolveCodexInstallationId()`
- **THEN** the resolver generates a v4 UUID, writes it to the file with mode 0644, fsync, and returns the UUID
- **AND** subsequent calls in the same or future processes return the **same** UUID

#### Scenario: Existing valid UUID is reused
- **GIVEN** the file contains a valid v4 UUID
- **WHEN** the resolver is called
- **THEN** it returns the file contents verbatim and does not rewrite the file

#### Scenario: Corrupted file is rewritten
- **GIVEN** the file exists but contents are not a valid UUID (truncated, non-UUID text, empty)
- **WHEN** the resolver is called
- **THEN** it generates a fresh v4 UUID, rewrites the file, and returns the new UUID

### Requirement: UUID Threaded Through Codex Auth Plumbing
The system SHALL inject the resolved UUID as `credentials.installationId` into every `getModel(...)` call regardless of which OAuth account is active.

#### Scenario: Account switch keeps installation id stable
- **GIVEN** opencode rotates from codex account A to codex account B mid-session
- **WHEN** the next Responses turn is built
- **THEN** `credentials.installationId` is the same UUID for both A and B
- **AND** the request body `client_metadata["x-codex-installation-id"]` is also unchanged

### Requirement: Field Present In Every Outgoing Request Body
The system SHALL emit `body.client_metadata["x-codex-installation-id"] = <UUID>` on every codex Responses request, on both HTTP streaming and WebSocket transports.

#### Scenario: Two consecutive turns carry the field
- **GIVEN** a steady-state codex session with two consecutive user turns
- **WHEN** both outgoing request bodies are captured
- **THEN** both contain `client_metadata["x-codex-installation-id"]` equal to the persisted UUID
- **AND** no other dimension of `client_metadata` is removed by this change

### Requirement: No Silent Fallback On IO Failure
The system SHALL surface filesystem errors from the resolver to the auth bootstrap; it MUST NOT mint a transient per-process UUID as fallback.

#### Scenario: Read-only home blocks codex provider start
- **GIVEN** `${OPENCODE_DATA_HOME}` is read-only and the file does not exist
- **WHEN** the resolver runs
- **THEN** the resolver throws / rejects with the underlying IO error
- **AND** codex provider initialization fails loudly rather than starting with an undefined or randomly-minted installationId

### Requirement: HTTP Header Surface Unchanged
The system SHALL NOT add `x-codex-installation-id` as an HTTP header on the normal Responses streaming turn path, to stay byte-aligned with upstream wire shape.

#### Scenario: Outgoing HTTP headers unchanged
- **GIVEN** a codex turn with the fix applied
- **WHEN** outgoing request HTTP headers are inspected
- **THEN** there is no `x-codex-installation-id` header on the normal streaming path
- **AND** the field exists only inside the JSON body's `client_metadata`

## Acceptance Checks

- [ ] `${OPENCODE_DATA_HOME}/codex-installation-id` exists after first launch with mode 0644 and a valid v4 UUID string body.
- [ ] Same UUID is returned across two `resolveCodexInstallationId()` calls in the same process, and across two opencode launches sharing the same data home.
- [ ] Corrupted (non-UUID) or empty file is rewritten with a fresh v4 UUID; the rewritten file is then idempotent on the next call.
- [ ] `credentials.installationId` equals the persisted UUID on every `getModel(...)` call regardless of which OAuth account is active.
- [ ] Outgoing Responses request body (HTTP streaming transport) contains `client_metadata["x-codex-installation-id"] = <UUID>` on two consecutive turns of one session.
- [ ] Outgoing Responses-over-WebSocket first frame body contains `client_metadata["x-codex-installation-id"] = <UUID>`.
- [ ] Outgoing HTTP headers on the normal Responses streaming path do NOT contain `x-codex-installation-id` (upstream alignment).
- [ ] Resolver throws / rejects when data home is read-only and file does not exist; codex provider start is refused (no fallback UUID minted).
- [ ] Account-switch within one session keeps `body.client_metadata["x-codex-installation-id"]` byte-identical across the rotation boundary.
- [ ] No other `client_metadata` key (e.g. `x-codex-window-id`) is removed or altered by this change.
