# Spec: Gmail MCP Background Token Refresh

## Purpose

- Ensure Gmail and Google Calendar managed apps keep a valid shared Google access token in the background so user-visible Gmail operations do not depend on the next tool call to discover expiry.

## Requirements

### Requirement: Proactive background refresh

The system SHALL proactively refresh shared Google MCP tokens in a daemon-start background sweep before they expire.

#### Scenario: token is nearing expiry

- **GIVEN** `gauth.json` contains a valid Google refresh token and access token
- **WHEN** the background controller observes that the access token is within the proactive refresh window
- **WHEN** the daemon-start background controller observes that the access token is within the proactive refresh window
- **THEN** it SHALL refresh the token and persist the new access token data back to `gauth.json`

#### Scenario: daemon restarts but no Google tool is touched

- **GIVEN** the daemon has just started and Gmail/Calendar are lazy-loaded
- **WHEN** the background sweep runs before any Google MCP tool is invoked
- **THEN** it SHALL still refresh near-expiry tokens and update shared observability state

### Requirement: On-demand refresh remains available

The system SHALL continue to refresh on-demand when a Gmail/Calendar tool call encounters an expiring or expired token.

#### Scenario: a tool call arrives after background refresh missed the window

- **GIVEN** a Gmail tool call starts while the stored access token is expired or nearly expired
- **WHEN** the tool resolves its access token
- **THEN** it SHALL refresh through the shared Google token helper before making the API call

### Requirement: Shared token storage remains authoritative

The system SHALL keep `gauth.json` as the shared source of truth for Gmail and Calendar token freshness.

#### Scenario: refresh succeeds for one managed Google app

- **GIVEN** Gmail triggers a refresh in the background or on-demand
- **WHEN** the token refresh succeeds and Google rotates the refresh token
- **THEN** the updated token set SHALL be written back to `gauth.json` for both managed apps to consume

### Requirement: Refresh success updates observability

The system SHALL publish refresh success so managed-app status/observability can reflect the refreshed token state.

#### Scenario: background sweep completes successfully

- **GIVEN** a daemon-start refresh sweep refreshed shared Google tokens
- **WHEN** the refresh completes without error
- **THEN** the managed-app surface SHALL receive an updated event or snapshot reflecting the new token freshness

## Acceptance Checks

- A Gmail tool call after token expiry still succeeds because the shared helper refreshes on demand.
- The background controller refreshes the token before expiry and persists the updated token payload to `gauth.json`.
- Calendar remains compatible because it continues to read the same shared token source.
