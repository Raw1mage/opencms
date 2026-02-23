# Event: Web alignment matrix execution (P0/P1)

Date: 2026-02-23
Status: Done

## 1) Scope

- P0: Restore Web question request/reply flow in the session dock.
- P1: Add Web account management minimum UI (view + set active account).
- P1: Extend Web status popover into an admin-lite view with account/rotation visibility.

## 2) Decisions

1. **Question flow parity first**
   - Re-enable question request wiring in `pages/session/index.tsx`.
   - Block prompt input when either permission request or question request exists.

2. **Account management via Settings (incremental)**
   - Implement a lightweight `SettingsAccounts` panel instead of full TUI-equivalent admin clone.
   - Keep operations to safe minimum: inspect account families + set active account.

3. **Admin-lite inside status popover**
   - Add an `Accounts` tab showing:
     - rotation recommendations (`/rotation/status`)
     - account summary (`/account`)
   - Keep mutating actions in Settings to avoid overloading popover interaction complexity.

## 3) Changed files

- `packages/app/src/pages/session/index.tsx`
- `packages/app/src/components/settings-accounts.tsx` (new)
- `packages/app/src/components/dialog-settings.tsx`
- `packages/app/src/components/status-popover.tsx`

## 4) Risks / follow-up

- New account UI uses generic labels; localization coverage can be expanded later.
- Full TUI `/admin` parity (provider/account/model deep controls) remains a future phase.
- If product requires account deletion/toggle on Web, extend `SettingsAccounts` with guarded actions.

## 5) Additional fix (post-execution)

- Resolved app typecheck blocker in `packages/app/src/context/local.tsx`.
  - Root cause: `config.model` now follows SDK `Model` object typing; old logic assumed string format (`provider/model`) and called `.split("/")`.
  - Fix: add `parseConfiguredModel()` to normalize both legacy string and object-shaped model values before validation.

## 6) Validation

- `bun x tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅
- `bun turbo typecheck --filter=@opencode-ai/app` ✅

## 7) UX/i18n polish follow-up

- Added Settings deep-link capability via `DialogSettings` prop: `initialTab`.
  - Status popover now opens Settings directly on `accounts` tab from the manage action.
- Replaced newly introduced hardcoded account/status labels with i18n keys in `packages/app/src/i18n/en.ts` and consumers.
  - Includes: accounts tab labels, refresh/manage actions, account page copy, toasts, account type labels, and cooldown fallback text.
- Re-ran app typechecks after polish; both checks pass.

## 8) Docker Web service rebuild (reuse existing production setup)

- Rebuilt `/docker` web deployment path to be directly runnable from repo root and `docker/` scripts.
- Kept existing production model (same image name, `/opt/opencode` runtime layout, same web command and auth env) while fixing broken path/context assumptions.

### File-to-function mapping (Docker)

- `docker/docker-compose.production.yml`
  - Build context changed to repo root (`..`) and Dockerfile path pinned to `docker/Dockerfile.production`.
  - `PROJECTS_DIR` fallback updated to a concrete relative path (`../projects`) to avoid unresolved `$HOME` literals in Compose substitution.

- `docker/webctl.sh`
  - Added `PROJECT_ROOT` and corrected build/sync path resolution.
  - Binary/frontend checks now point to repo-root artifacts.
  - Docker build now uses `docker/Dockerfile.production` with repo-root context.

- `docker/docker-setup.sh`
  - Updated image build command to `docker/Dockerfile.production`.
  - Updated usage examples to `./docker/...` paths.

- `docker/sync-config.sh`, `docker/Dockerfile.production`, `docker/docker-compose.production.yml` (comments)
  - Aligned command examples to current `/docker` location and `docker compose` syntax.

### Validation

- `docker compose -f docker/docker-compose.production.yml --profile web config` ✅
- `bash -n docker/webctl.sh && bash -n docker/docker-setup.sh && bash -n docker/sync-config.sh` ✅

## 9) Localization follow-up (CN)

- Added new account/admin-lite i18n keys to:
  - `packages/app/src/i18n/zh.ts`
  - `packages/app/src/i18n/zht.ts`
- Key groups covered:
  - `status.popover.tab.accounts`
  - `status.popover.accounts.*`
  - `common.refresh`, `common.manage`
  - `settings.accounts.*` (title/summary/loading/empty/actions/toasts/type/cooldown)
- Remaining non-blocking follow-up:
  - Other locales currently fallback to English for these newly introduced keys.

## 10) Web auth refactor (replace basic-auth prompt flow)

- Replaced server-side HTTP Basic challenge flow with cookie-based web session auth for browser UX and security hardening.
- Added CSRF protection for mutating API requests and login failure lockout guard.
- Frontend now renders a login gate when auth is enabled but session is missing, and uses credentialed fetch + CSRF headers.

### File-to-function mapping (Web auth)

- `packages/opencode/src/server/web-auth.ts` (new)
  - Stateless signed session cookie primitives, CSRF token lifecycle, failed-login lockout bookkeeping, and route protection helpers.

- `packages/opencode/src/server/app.ts`
  - Replaced `hono/basic-auth` middleware with `WebAuth` middleware:
    - public-route allowlist (`/global/health`, `/global/auth/*`, frontend assets)
    - protected API 401/403 JSON responses
    - CSRF check for non-GET/HEAD/OPTIONS methods.
  - Enabled CORS credentials to support cookie auth for allowed origins.

- `packages/opencode/src/server/routes/global.ts`
  - Added auth endpoints:
    - `GET /global/auth/session`
    - `POST /global/auth/login`
    - `POST /global/auth/logout`

- `packages/app/src/context/web-auth.tsx` (new)
  - Browser auth state manager (session probe/login/logout) and credentialed `authorizedFetch` wrapper with CSRF injection.

- `packages/app/src/components/auth-gate.tsx` (new)
  - Login UI gate shown when server auth is enabled and user is unauthenticated.

- `packages/app/src/context/global-sdk.tsx`
  - Switched SDK/event fetch to auth-aware `authorizedFetch` (cookie + CSRF semantics).

- `packages/app/src/app.tsx`
  - Inserted `WebAuthProvider` + `AuthGate` around router runtime.

- `packages/app/src/components/terminal.tsx`
  - Removed URL embedded basic credentials for PTY websocket connection.

### Validation

- `bun x tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅
- `bun x tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ⚠️
  - Blocked only by known baseline noise in `packages/opencode/src/plugin/antigravity/plugin/storage.legacy.ts` (`vitest` / implicit any), unrelated to this auth change set.

## 11) Security hardening follow-up: move from plaintext env password to htpasswd-style file

- User feedback accepted: plaintext password in env is insufficient for release-grade home deployment defaults.
- Implemented credential-file path with hashed password verification (htpasswd-like `username:hash` lines), while preserving backward compatibility for legacy env username/password mode.

### File-to-function mapping (credential management)

- `packages/opencode/src/server/web-auth-credentials.ts` (new)
  - Loads and caches htpasswd-style credential file.
  - Verifies passwords via `Bun.password.verify()` against stored hash.
  - Provides auth enablement and username hint lookup.

- `packages/opencode/src/server/web-auth.ts`
  - Auth enablement now routes via credential manager (file or legacy env).
  - Credential verification delegated to hashed-file verifier.
  - Session signing secret material now includes credential file path context (or explicit `OPENCODE_SERVER_AUTH_SECRET`).

- `packages/opencode/src/server/routes/global.ts`
  - `GET /global/auth/session` now returns `usernameHint` for login UX.
  - Login path updated for async credential verification.

- `packages/opencode/src/flag/flag.ts`
  - Added flags:
    - `OPENCODE_SERVER_HTPASSWD`
    - `OPENCODE_SERVER_PASSWORD_FILE`

- `packages/app/src/components/auth-gate.tsx`
  - Username field prefill now uses backend-provided `usernameHint` (instead of hardcoded default).

- `packages/app/src/context/web-auth.tsx`
  - Session status model extended with `usernameHint`.

- `docker/docker-compose.production.yml`
  - Added `OPENCODE_SERVER_HTPASSWD` default path: `/opt/opencode/config/opencode/.htpasswd`.
  - Removed default fallback password value (`changeme`) to avoid insecure accidental deployment defaults.

### Runtime provisioning on this host

- Created hashed credential file at:
  - `/opt/opencode/config/opencode/.htpasswd`
- Format:
  - `yeatsluo:<argon2-hash>`

### Validation

- `./docker/webctl.sh deploy` ✅
- `GET /global/auth/session` before login: `{"enabled":true,"authenticated":false,"usernameHint":"yeatsluo"}` ✅
- `POST /global/auth/login` with configured credentials: success ✅
- `GET /global/auth/session` after login: `authenticated:true` ✅
- `opencode-web` container state: `running healthy` ✅

## 12) Session signing hardening: stable auth secret rollout

- Added and applied `OPENCODE_SERVER_AUTH_SECRET` so session signing does not rely on weaker implicit defaults.
- Persisted deployment-time secret in `docker/.env` (local deployment context) and wired compose to pass it into services.

### File-to-function mapping

- `docker/.env` (new)
  - Stores local deployment secret `OPENCODE_SERVER_AUTH_SECRET`.

- `docker/docker-compose.production.yml`
  - Added `OPENCODE_SERVER_AUTH_SECRET` passthrough for both `opencode` and `opencode-web` services.

### Validation

- Container env contains `OPENCODE_SERVER_AUTH_SECRET` (presence-only check) ✅
- `opencode-web` remains `running healthy` after recreate ✅
- Auth flow still works (`/global/auth/session`, `/global/auth/login`) ✅
