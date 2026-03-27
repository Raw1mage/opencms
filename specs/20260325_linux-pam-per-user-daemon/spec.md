# Spec

## Purpose
- 定義 gateway 對 Google 登入相容路徑的行為邊界，使它能在不破壞 Linux PAM 主體模型下，將已綁定的 Google 身分導向正確的 per-user daemon。

## Requirements

### Requirement: Preserve Linux PAM Authority
The system SHALL continue to treat Linux PAM as the primary authority for per-user daemon access.

#### Scenario: Linux login unchanged
- **GIVEN** a user logs in through Linux PAM
- **WHEN** gateway establishes the session
- **THEN** the user is routed to the corresponding per-user daemon as today.

### Requirement: Accept Bound Google Login
The system SHALL allow Google login as a compatible gateway entry only when the Google identity is already bound to an active Linux account.

#### Scenario: Bound Google identity
- **GIVEN** a Google identity that matches an existing Linux binding
- **WHEN** the user completes Google login
- **THEN** gateway routes the request to the bound Linux user’s per-user daemon.

### Requirement: Reject Unbound Google Login
The system SHALL reject Google logins that have no valid Linux binding.

#### Scenario: Unbound Google identity
- **GIVEN** a Google identity with no matching Linux binding
- **WHEN** the user completes Google login
- **THEN** gateway denies access and instructs the user to complete Linux login and binding first.

### Requirement: Separate Token Storage From Binding Data
The system SHALL keep shared Google OAuth token storage separate from Linux↔Google identity binding data.

#### Scenario: Shared token present
- **GIVEN** `gauth.json` contains valid Google OAuth tokens
- **WHEN** gateway evaluates login binding
- **THEN** it must not treat the token file alone as proof of Linux identity binding.

### Requirement: Use Global Binding Registry
The system SHALL store Linux↔Google binding data in a global registry module under `/etc/opencode/`.

#### Scenario: Binding lookup
- **GIVEN** a Google identity attempts gateway login
- **WHEN** the gateway checks binding state
- **THEN** it queries the registry module under `/etc/opencode/` and routes only if a Linux user binding exists.

## Acceptance Checks
- Linux PAM login behavior remains unchanged for existing users.
- Bound Google identities reach the correct per-user daemon.
- Unbound Google identities are rejected with a clear message.
- `gauth.json` is not used as the sole binding authority.
