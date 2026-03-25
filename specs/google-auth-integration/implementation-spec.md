# Implementation Spec

## Goal
- Define and implement a gateway-compatible Google login path that routes only pre-bound Google identities to the correct per-user daemon while preserving Linux PAM as the primary authority.

## Scope
### IN
- Gateway login policy for Google-compatible entry
- Linux user ↔ Google identity binding lookup contract
- Explicit rejection path for unbound Google identities
- Architecture / event doc sync for the identity boundary

### OUT
- Replacing Linux PAM with Google login
- New fallback or auto-match logic
- Token format redesign
- Frontend binding UI unless later approved

## Assumptions
- Linux user remains the authoritative per-user daemon owner.
- Google account binding exists before Google login is accepted.
- `gauth.json` is token storage, not sufficient by itself to prove binding.
- Binding data will be stored separately from shared Google OAuth token material.
## Stop Gates
- Stop if the binding source must change from a local/user-scoped store to a global registry.
- Stop if a proposed implementation introduces any fallback or auto-match behavior.
- Stop if the team wants Google to become the primary login authority instead of Linux PAM.
- Stop if someone proposes reusing `gauth.json` as binding truth instead of token-only storage.
## Critical Files
- /home/pkcs12/projects/opencode/packages/opencode/src/server/routes/*
- /home/pkcs12/projects/opencode/packages/opencode/src/account/*
- /home/pkcs12/projects/opencode/packages/opencode/src/auth/*
- /home/pkcs12/projects/opencode/packages/opencode/src/mcp/app-registry.ts
- /home/pkcs12/projects/opencode/packages/opencode/src/mcp/oauth-provider.ts
- /home/pkcs12/projects/opencode/packages/opencode/src/mcp/oauth-callback.ts
- /home/pkcs12/projects/opencode/daemon/opencode-gateway.c
- /home/pkcs12/projects/opencode/docs/events/event_20260325_gateway_google_login_binding.md

## Structured Execution Phases
- Phase 1: Confirm binding data model and lookup boundary.
- Phase 2: Implement gateway routing / rejection semantics.
- Phase 3: Validate no fallback and sync docs.

## Validation
- Confirm bound Google identity reaches the correct daemon.
- Confirm unbound Google identity is rejected.
- Confirm Linux PAM login is unchanged.
- Confirm `gauth.json` does not become implicit binding truth.

## Handoff
- Build agent must read this spec first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md / handoff.md before coding.
- Build agent must materialize runtime todo from tasks.md and preserve planner task naming.
- Build agent must preserve fail-fast behavior and avoid any fallback mechanism.
