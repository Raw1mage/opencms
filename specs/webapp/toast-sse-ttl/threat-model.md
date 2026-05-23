# Threat Model

## Assets

- User-specific operational messages, including account rotation/rate-limit text.
- Session/workspace identifiers and provider/account hints embedded in toast messages.

## Threats

- Cross-user disclosure if user-scoped toasts are treated as system/global announcements.
- Stale-action confusion when old failure/success notices appear hours later.
- Future gateway federation accidentally replaying or fan-outing all toasts without audience metadata.

## Mitigations

- Explicit `scope` metadata on every toast.
- Fail-closed frontend display for missing freshness metadata.
- TTL drop before any user-visible toast rendering.
