# Spec: Toast Scope and TTL over Global SSE

## Purpose

Prevent stale or cross-scope toast notifications from being displayed after SSE reconnect or delayed delivery while keeping reducer/resync state recovery unchanged.

## Requirements

### Requirement: Scoped toast payloads

- R1: Every backend `tui.toast.show` payload must include a valid `scope`.
- R5: User/workspace/session-scoped toasts must not be silently promoted to `system` scope.

#### Scenario: System restart toast

- Given the backend publishes a restart notification
- When the toast is serialized for SSE
- Then it includes `scope: "system"`, `emittedAt`, and `ttlMs`

#### Scenario: User-sensitive rotation toast

- Given the backend publishes a provider rotation or rate-limit notification
- When the toast is serialized for SSE
- Then it includes `scope: "user"`, `"workspace"`, or `"session"` and is not promoted to `"system"`

### Requirement: Freshness-gated frontend display

- R2: Every backend `tui.toast.show` payload must include numeric `emittedAt` and `ttlMs` freshness metadata.
- R3: Frontend toast display must drop events where `Date.now() - emittedAt > ttlMs`.
- R4: Frontend toast display must drop events with missing/invalid freshness metadata.

#### Scenario: Fresh toast display

- Given a toast has valid scope and `Date.now() - emittedAt <= ttlMs`
- When `GlobalSync` receives the event
- Then it calls `showToast` once

#### Scenario: Stale or malformed toast drop

- Given a toast is stale or lacks valid freshness metadata
- When `GlobalSync` receives the event
- Then it does not call `showToast`

## Acceptance Checks

- AC1: Fresh toast events call `showToast` exactly once.
- AC2: Stale toast events do not call `showToast` and log a drop trace.
- AC3: Missing `emittedAt`, missing `ttlMs`, invalid `ttlMs`, or invalid `scope` do not call `showToast`.
- AC4: Backend restart toasts include `scope: "system"` and `ttlMs` matching their display duration.
- AC5: Rotation/rate-limit/auth toasts published through `publishToastTraced` include non-system scope unless explicitly system-wide.

## Traceability

- R1 → DD-2, INV-3, T1, T2
- R2 → DD-3, INV-1, INV-2, T1, T2
- R3 → DD-3, INV-1, T3, T4
- R4 → DD-4, INV-2, T3, T4
- R5 → DD-5, threat model, T2, T4
