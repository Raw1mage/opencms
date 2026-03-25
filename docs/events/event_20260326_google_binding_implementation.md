# Event: Google Account Binding Procedure Implementation

**Date**: 2026-03-26
**Branch**: worktree-google-auth-binding (beta worktree)
**Plan**: plans/20260325_google-auth-integration/

## Scope

Implementation of the Google account binding procedure for PAM users, covering:

- Tasks 5.1-5.3: Binding service module (Phase 1)
- Tasks 6.1-6.3: Binding API routes (Phase 2)
- Tasks 7.1-7.4: C gateway OAuth redirect + callback (Phase 3)
- Tasks 8.1-8.2: Deployment script updates (Phase 4)
- Tasks 10.1-10.3: MCP OAuth binding piggyback unification

## Key Decisions

1. **Permission model**: Group-writable binding file (`0664`, `root:opencode` group). Per-user daemons write; C gateway reads.
2. **Cardinality**: 1:1 (one Google email ↔ one Linux user). Bidirectional uniqueness enforced at write time.
3. **OAuth flow for binding** (per-user daemon, PAM-authenticated):
   - Reuses `GOOGLE_CALENDAR_CLIENT_ID` credentials
   - Scope: `openid email profile` (minimal)
   - Callback extracts verified email via Google userinfo endpoint
4. **OAuth flow for login** (C gateway, unauthenticated):
   - Added libcurl dependency for server-side token exchange
   - In-memory state table with 5-minute TTL
   - Synchronous curl (acceptable for low-frequency login operations)
5. **Login page**: "Sign in with Google" link triggers gateway OAuth redirect
6. **Existing `POST /auth/login/google`**: Preserved as API fallback alongside new OAuth redirect
7. **MCP OAuth piggyback**: MCP apps (google-calendar, gmail) OAuth callback now auto-binds Google identity for gateway login. Scope merge always includes `openid email profile`. Binding is best-effort — failure (e.g., already bound) does not block MCP app enablement.

## Files Changed

### Created
- `packages/opencode/src/google-binding/index.ts` — Binding registry CRUD (mtime cache, mutex, atomic write)
- `packages/opencode/src/server/routes/google-binding.ts` — API routes (status, connect, callback, unbind)

### Modified
- `packages/opencode/src/server/routes/mcp.ts` — Added identity scopes to scope merge + GoogleBinding piggyback in OAuth callback
- `packages/opencode/src/server/app.ts` — Route mount for `/google-binding`
- `packages/opencode/src/server/web-auth.ts` — Added `/google-binding` to API_PREFIXES
- `daemon/opencode-gateway.c` — libcurl, OAuth state management, `GET /auth/login/google` redirect, `GET /auth/google/callback` handler
- `daemon/login.html` — "Sign in with Google" button
- `webctl.sh` — Added `-lcurl` to compile_gateway()
- `install.sh` — Binding file initialization in system_init()

## Verification

- TypeScript build: No new errors in google-binding files
- C gateway: Requires `libcurl4-openssl-dev` for compilation (IDE diagnostics expected without it)
- Binding flow: PAM login → GET /api/v2/google-binding/connect → Google OAuth → callback → binding created
- Login flow: Click "Sign in with Google" → Gateway OAuth redirect → callback → JWT or 403

## Architecture Sync

Updated `specs/architecture.md` section "Gateway Google Login Binding Boundary" — restructured into subsections:
- **Binding Registry**: storage format, permissions, cardinality, service module reference
- **Gateway-Owned Endpoints**: POST /auth/login/google (API fallback), GET /auth/login/google (OAuth redirect), GET /auth/google/callback (OAuth callback with libcurl)
- **Per-User Daemon Binding API**: status, connect, callback, unbind routes with route file reference
- **Login Page**: Sign in with Google link description
- **Architecture Sync**: Verified — full section rewrite completed
