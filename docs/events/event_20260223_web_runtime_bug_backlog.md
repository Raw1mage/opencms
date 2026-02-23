# Event: Web runtime bug backlog and logging baseline

Date: 2026-02-23
Status: In Progress

## 1) Logging baseline (P0)

For each web-runtime bug report, capture all of the following:

1. **User symptom** (what user sees)
2. **Repro steps** (minimum deterministic path)
3. **Environment**
   - mode: docker / direct web
   - host: WSL / Linux / macOS / Windows
   - URL/port
4. **Artifacts**
   - browser screenshot
   - browser console errors
   - network request (status + response)
   - server logs (`docker logs opencode-web` or direct process stdout)
5. **Expected vs actual**
6. **Fix status** (open / in-progress / fixed / verified)

## 2) Active bug backlog

### BUG-001: Web console unavailable

- Source: user report
- Status: In Progress
- Priority: High
- Findings:
  - Web auth migration introduced a fetch path mismatch: directory-scoped SDK client (`context/sdk.tsx`) still used `platform.fetch` instead of auth-aware fetch wrapper.
  - Consequence: session-scoped API calls (including PTY lifecycle used by web console/terminal) can fail under authenticated mode.
- Mitigation applied:
  - `packages/app/src/context/global-sdk.tsx`: expose auth-aware `fetch` from global SDK context.
  - `packages/app/src/context/sdk.tsx`: switch client fetch from `platform.fetch` to `globalSDK.fetch`.
  - Rebuilt frontend and restarted direct web service with `OPENCODE_FRONTEND_PATH` pointing to latest local `packages/app/dist`.
- Validation:
  - `/global/health` = 200
  - `/global/auth/session` = 200 (auth enabled)
  - authenticated `POST /pty` = 200

### LOG-FIX-002: dynamic import chunk fetch failure on rollout

- Symptom:
  - Browser error: `TypeError: Failed to fetch dynamically imported module: .../assets/session-*.js`

- Root cause:
  - Frontend deploy with hashed chunk replacement can leave a running tab on stale chunk graph (old module URL no longer present after rebuild).

- Fix:
  - Added dynamic-import recovery in `packages/app/src/entry.tsx`:
    - listens to `vite:preloadError`
    - listens to `unhandledrejection` for `Failed to fetch dynamically imported module`
    - performs one guarded auto-reload (anti-loop guard)

- Deployment:
  - Rebuilt `packages/app` and restarted direct web with `OPENCODE_FRONTEND_PATH=/home/pkcs12/projects/opencode/packages/app/dist`.

- Validation:
  - direct web health 200
  - login endpoint 200

### LOG-FIX-003: TUI/basic-auth compatibility regression after web auth refactor

- Symptom:
  - user reports `bun run dev` / TUI cannot load model or restore session.

- Root cause:
  - server middleware switched from Basic-only auth to cookie-session auth and no longer accepted `Authorization: Basic ...`.
  - TUI/CLI paths still rely on Basic auth behavior in password-enabled environments.

- Fix:
  - `packages/opencode/src/server/web-auth.ts`
    - add Basic header parser + credential verifier (`verifyBasicAuth`).
  - `packages/opencode/src/server/app.ts`
    - auth middleware now accepts valid Basic auth as compatibility path before cookie-session checks.

- Validation:
  - Compatibility harness (`opencode serve` with password env):
    - unauthenticated `GET /pty` => `401`
    - Basic-auth `GET /pty` => `200`

### LOG-FIX-004: auth mode warning text mismatch (serve command)

- Symptom:
  - warning still claims `OPENCODE_SERVER_PASSWORD is not set; server is unsecured` even under credential-file mode.

- Fix:
  - `packages/opencode/src/cli/cmd/serve.ts` now uses `WebAuthCredentials.enabled()` and prints mode-aware messages:
    - unsecured / legacy env / credential file.

### BUG-002: Web model selection logic differs from TUI /admin

- Source: user report
- Status: In Progress
- Priority: High
- Notes:
  - Current Web implementation is a lightweight settings/select flow.
  - TUI `/admin` includes multi-account + model-activity + rotation-aware model/account selection behavior.
  - Requires parity matrix and phased port plan.
  - Phase 2 partial landing completed:
    - provider enable/disable controls in Web settings,
    - disabled-provider list with re-enable action,
    - auto re-enable when user reconnects a previously disabled provider.
  - Phase 3 read-only slice landed:
    - model routing recommendations panel in `Settings > Models`.

### BUG-003: Docker workspace sandbox mismatch vs host system workspace

- Source: user report
- Status: Mitigated
- Priority: High
- Notes:
  - Docker runtime introduces workspace boundary and path mapping constraints.
  - Switched active runtime to direct web service (`opencode web --hostname 0.0.0.0 --port 1080`) for host workspace parity.
  - Keep Docker mode as optional isolation profile.

## 3) Decision tracking

- Interim decision accepted: for immediate operations, use **direct web service** as primary mode; keep docker as optional path.
- Isolation decision accepted: separate Web development runtime from TUI/runtime baseline using a physically isolated clone + isolated HOME/XDG roots.

## 5) Environment isolation execution (repo + runtime split)

- Created isolated clone:
  - `/home/pkcs12/projects/opencode-web-isolated`
  - clone mode: `git clone --no-hardlinks` (avoid object hardlink coupling)

- Created isolated runtime home:
  - `/home/pkcs12/opencode-web-home`
  - isolated config/data/cache/state roots under this HOME

- Provisioned isolated auth assets:
  - `/home/pkcs12/opencode-web-home/.config/opencode/.htpasswd`
  - `/home/pkcs12/opencode-web-home/.config/opencode/web-auth-secret`

- Added isolated process manager script:
  - `/home/pkcs12/projects/opencode-web-isolated/scripts/web-isolated.sh`
  - commands: `start|stop|restart|status`
  - default port: `1180` (keeps existing `1080` runtime untouched)

- Validation:
  - isolated health endpoint `http://127.0.0.1:1180/global/health` => 200
  - isolated auth session endpoint => 200
  - isolated login (`yeatsluo`) => 200

## 4) Error-log driven fixes executed

### LOG-FIX-001: misleading startup warning in direct web mode

- Symptom:
  - Startup log always printed:
    - `OPENCODE_SERVER_PASSWORD is not set; server is unsecured.`
  - But runtime was actually secured via htpasswd credential file.

- Root cause:
  - `packages/opencode/src/cli/cmd/web.ts` only checked `OPENCODE_SERVER_PASSWORD` and ignored credential-file mode.

- Fix:
  - `web.ts` now checks `WebAuthCredentials.enabled()`.
  - Startup message now reflects actual mode:
    - unsecured (none configured)
    - legacy env password mode
    - credential file mode (`OPENCODE_SERVER_HTPASSWD` / password file)

- Validation:
  - Typecheck runs with only known baseline unrelated errors in `storage.legacy.ts`.

### LOG-FIX-005: stale persisted PTY id causes terminal connect no-output/session-not-found

- Symptom:
  - Web terminal tab opens but fails to attach output after runtime/server restart.
  - Backend may emit `Session not found` for `/pty/:id/connect` on previously persisted local terminal IDs.

- Root cause:
  - `packages/app/src/context/terminal.tsx` persists terminal ids per workspace.
  - After server restart, old PTY processes are gone but stale ids remain in local persisted terminal state.

- Fix:
  - Added one-time hydration validation after terminal store load:
    - for each persisted PTY id, call `sdk.client.pty.get({ ptyID })`.
    - if missing, prune it from local state via existing `removeExited()` path.
  - Keeps valid tabs and removes only stale sessions.

- Validation target:
  - Restart server while retaining browser local state.
  - Re-open existing workspace/session and verify stale PTY rows are removed and new terminal can connect normally.

### LOG-FIX-006: path boundary denial now has explicit Web diagnostics

- Symptom:
  - File/workspace actions could fail with raw backend message:
    - `Access denied: path escapes project directory`
  - User-facing context was too generic in several Web flows.

- Root cause:
  - Error handling in multiple UI paths used generic extraction with no boundary-aware translation.

- Fix:
  - Added shared formatter: `packages/app/src/utils/api-error.ts`.
  - Detects project-boundary denial and maps to explicit workspace guidance text.
  - Wired into key UX paths:
    - `packages/app/src/context/file.tsx`
    - `packages/app/src/components/prompt-input/submit.ts`
    - `packages/app/src/pages/layout/helpers.ts`

- Validation target:
  - Trigger a boundary-denied action from Web and verify toast/error copy now explains workspace scope and recovery path (switch/open correct workspace).

### LOG-FIX-007: terminal input has no immediate visual echo until page reload

- Symptom:
  - In Web terminal, typing shows no immediate on-screen feedback.
  - After `Ctrl+F5`, buffered terminal output appears and command effects are visible.

- Root cause:
  - WebSocket message handler in `packages/app/src/components/terminal.tsx` treated all binary frames as control frames.
  - Non-control binary PTY payload frames were dropped instead of rendered.

- Fix:
  - Keep control-frame handling for `0x00 + JSON` metadata.
  - Decode non-control `ArrayBuffer` frames as UTF-8 terminal payload and write immediately.
  - Add `Blob` frame decoding fallback for cross-runtime websocket frame delivery.

- Validation target:
  - In Web terminal, type continuously and verify immediate visual echo/output without reload.
