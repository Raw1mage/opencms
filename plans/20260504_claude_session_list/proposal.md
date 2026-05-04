# Claude Session List

## Requirement

Provide an operator-facing Claude session list so users can monitor Claude-side session progress from OpenCode without manually browsing XDG storage paths.

## Scope In

- Discover the authoritative Claude/OpenCode session metadata source under XDG storage.
- Define a read-only listing API or existing API extension for Claude-related sessions.
- Define a UI surface that shows session identity, status/progress, last activity, and a drill-down path to the existing session detail stream.
- Preserve the existing XDG storage contract and DB-backed session API boundary.

## Scope Out

- Mutating Claude sessions from the list view.
- Reading session files directly from the frontend.
- Adding fallback discovery from legacy project-local `.claude` folders.
- Daemon or gateway restart.

## Constraints

- Fail fast if the source of truth is unavailable; do not silently fall back to legacy folders.
- Reuse `Session.listGlobal`, existing session routes, and system-manager session APIs where possible.
- Do not expose secrets or raw provider credentials.
- Keep the feature read-only for MVP.

## Open Questions

- Whether the UI should be a dedicated page, an Admin Panel tab, or part of the existing task/session monitor.
- Whether the filter should mean provider family `claude-cli`, legacy provider `anthropic`, or both with explicit labels.
