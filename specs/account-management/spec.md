# Spec

## Purpose
- Implement a true 3-Tier Architecture for account management to prevent leaky abstractions.
- Centralize all identity deduplication and collision resolution in a strict Service Layer.
- Prevent the UI from freezing during account deletion by implementing asynchronous background cleanup.

## Requirements

### Requirement: Uniform Identity Service (3-Tier Architecture)
All account additions and deletions SHALL strictly pass through a Unified Identity Service (e.g., `Auth` module) that handles business logic. The Storage Layer (`Account` module) SHALL act as a pure repository that rejects duplicate IDs.

#### Scenario: Direct Storage Write Attempt
- **GIVEN** a script or CLI tool attempts to bypass the Identity Service and directly call the `Account` Storage Layer (`Account.add`) with an `accountId` that already exists in `accounts.json`.
- **WHEN** the storage layer function is executed.
- **THEN** the system throws an error immediately, refusing to silently overwrite the existing account.

#### Scenario: ID Collision on API Account
- **GIVEN** an existing API account named `Default` for provider `gemini-cli`.
- **WHEN** the user (via CLI, Admin panel, or Webapp) attempts to add another API account named `Default` for `gemini-cli` through the Identity Service.
- **THEN** the Identity Service intercepts the collision, appends a suffix to the new account ID (e.g., `Default-1`), and successfully creates the non-colliding account via the Storage Layer.

### Requirement: Non-Blocking Deletion
The system SHALL delete accounts and update the UI instantly without freezing the client application or terminal by delegating heavy cleanup tasks to the background.

#### Scenario: TUI Deleting Active Account
- **GIVEN** an active provider account in the TUI Settings -> Accounts list.
- **WHEN** the user hits `Enter` or clicks "Remove" on an account.
- **THEN** the account disappears from the list immediately, and background disposal/saving occurs asynchronously without blocking the render loop.

## Acceptance Checks
- `dialog-account.tsx` and `dialog-admin.tsx` do not freeze or lag significantly on account deletion.
- Bypassing the service layer by calling `Account.add` directly with an existing ID throws an explicit error instead of overwriting.
- Adding a duplicate account name via the CLI or TUI (`accounts.tsx` or `dialog-admin.tsx`) successfully creates a suffixed ID instead of throwing an error or overwriting the original (because they correctly use the Service Layer).
