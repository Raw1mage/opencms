# Event: phase 2 plan — user-home native runtime storage

Date: 2026-03-02
Status: In Progress

## Requirement (from owner)

- Runtime data (session/config/state/history) must follow authenticated Linux user home.
- Service account (`opencode`) should be nobody-style, and must not own user memory by home path.

## Current reality after phase 1

- `/home/opencode` dependency removed.
- Service now runs with:
  - `HOME=/nonexistent`
  - `XDG_*=/var/lib/opencode/*`
- This is correct for service identity hygiene, but data remains shared at service scope.

## Critical blocker discovered

- `opencode` service user does **not** have read/write permission to target user homes by default.
- Verified: `runuser -u opencode` cannot read/write `/home/pkcs12/.config/opencode`.
- Therefore, "just switching storage paths to /home/<login-user>" will fail immediately.

## Architecture decision needed

To satisfy both security and user-home ownership, we must avoid direct file I/O by service user into user homes.

### Recommended model

1. Keep web gateway process as `opencode` (no-home service identity).
2. Spawn/route to per-user runtime worker using existing sudo wrapper (`opencode-run-as-user`).
3. User worker process runs with native `HOME/XDG_*` of that Linux user.
4. Session/config/state APIs execute in that worker, not in gateway process.

## Detailed design (approved scope: documentation only)

### A) Process topology

```text
Browser
  -> opencode-web.service (gateway, user=opencode)
      -> auth/session verify
      -> resolve username
      -> dispatch RPC to user worker

User worker (run-as-user)
  - process user: <login_user>
  - HOME=/home/<login_user>
  - XDG_* follows user home
  - handles session/config/storage/account operations
```

### B) Worker lifecycle

- Keyed by username.
- Idle timeout (e.g. 15 min) for auto shutdown.
- Health ping every request before reuse.
- Hard restart when worker exits unexpectedly.

### C) RPC contract (minimum)

1. `session.*` (list/create/get/update/delete/message stream)
2. `config.*` (read/update global + user config)
3. `account.*` (read/switch/update account data)
4. `storage.top` / monitor APIs used by web UI

Transport options:

- Unix domain socket per user (`/run/opencode/user-<name>.sock`) + strict perms
- Or stdio bridge via long-lived child process

### D) Routing rules in gateway

- `requestUser` mandatory for mutable APIs.
- Gateway never touches user-home storage directly.
- Public endpoints remain gateway local (`/global/health`, static files, login/logout).

### E) Event log policy (your requirement)

- User memory/history: store in each user's own XDG (`~/.config`, `~/.local/share`, `~/.local/state`).
- Repo experience: keep curated copies in `repo/docs/events/`.
- Copy direction is one-way (runtime -> repo docs), avoid reverse overwrite.

## Minimal implementation stages

1. Define worker RPC surface for storage/session/config/account APIs.
2. Implement worker pool keyed by authenticated username.
3. Route web request context to matching worker.
4. Keep gateway-only concerns in service process (auth/CORS/static frontend).
5. Add migration utility from `/var/lib/opencode` shared data to per-user homes (optional, explicit command).

## Migration strategy

1. Freeze writes (maintenance mode toggle).
2. For each user, export sessions filtered by owner/username into that user's XDG storage.
3. Preserve source snapshot under `/var/lib/opencode/migration-backup/<timestamp>`.
4. Run consistency check (session count, latest timestamp, account file hash).
5. Enable per-user worker routing.

## Verification checklist

- [ ] Login as `pkcs12` and `betaman` sees isolated session lists.
- [ ] Same repo can be opened by both users without session cross-leak.
- [ ] `whoami/pwd/HOME` in terminal matches login user.
- [ ] `account.json` read/write happens only in current user home.
- [ ] `docs/events` copy pipeline works and is non-destructive.

## Open items (need owner confirmation later)

1. Worker idle timeout value (10/15/30 min).
2. Shared repo docs copy trigger (manual command vs auto daily sync).
3. Conflict policy when two users append same event topic.

## Phase 2-1 implementation (skeleton only, no traffic cut)

Implemented code skeleton for per-user worker orchestration without changing runtime routing behavior:

- Added `packages/opencode/src/server/user-worker/rpc-schema.ts`
  - Declares typed RPC envelope/method schema (`health`, `session.list`, `config.get`).
- Added `packages/opencode/src/server/user-worker/manager.ts`
  - Tracks observed authenticated usernames.
  - Builds run-as-user invocation plan via existing `LinuxUserExec` wrapper.
  - Does not spawn workers yet (planning-only, safe/no behavior change).
- Added `packages/opencode/src/server/user-worker/index.ts` exports.
- Added non-invasive hook in `server/app.ts`:
  - When `OPENCODE_USER_WORKER_SKELETON=1`, gateway records observed users into manager.
  - No API routing redirection yet.

This stage intentionally preserves existing request execution path and serves as scaffolding for phase 2-2.

## Phase 2-2 implementation (read-only pilot routing)

Implemented first traffic pilot for user worker path with feature flags:

- Added `packages/opencode/src/cli/cmd/user-worker.ts`
  - New internal command: `opencode user-worker --stdio`
  - JSON-line stdio worker protocol with `ready`/`heartbeat` and request-response handling.
  - Supports methods:
    - `health`
    - `session.list` (read-only)
    - `config.get` (read-only)

- Upgraded `packages/opencode/src/server/user-worker/manager.ts`
  - From plan-only -> spawn/manage/call long-lived per-user worker.
  - Uses existing run-as-user wrapper (`LinuxUserExec.buildSudoInvocation`) to run worker as authenticated Linux user.
  - Tracks pending RPC calls with timeout and worker-exit handling.
  - Added feature switches:
    - `OPENCODE_USER_WORKER_ENABLED=1` (enable manager runtime)
    - `OPENCODE_USER_WORKER_ROUTE_SESSION_LIST=1` (pilot routing for session list API)

- Wired route pilot in `packages/opencode/src/server/routes/session.ts`
  - `GET /session` now attempts user-worker `session.list` when routing flag is on and `requestUser` exists.
  - Falls back to existing in-process listing if worker path fails.

- Registered command in `packages/opencode/src/index.ts`
  - `UserWorkerCommand` added to CLI command table.

### Safety properties of this phase

- Read-only route pilot only (`session.list`).
- Feature-flag gated.
- Automatic fallback to legacy path on worker/RPC failure.
- No write-path routing cut yet.

## Phase 2-3 implementation (expand read-only pilot)

Expanded user-worker pilot routing beyond session list:

- Added RPC method `account.list` in user-worker schema and worker handler.
- Added route pilot flags in manager:
  - `OPENCODE_USER_WORKER_ROUTE_CONFIG_GET=1`
  - `OPENCODE_USER_WORKER_ROUTE_ACCOUNT_LIST=1`
- Updated gateway routing:
  - `GET /config` can route to user-worker `config.get` (flag-gated, fallback safe).
  - `GET /account` can route to user-worker `account.list` (flag-gated, fallback safe).

Safety remains unchanged:

- Read-only paths only.
- Feature-flag gated.
- Automatic fallback to legacy in-process behavior.

### Issue observed during rollout

- Runtime error reported by web UI:
  - `Error: worker not ready for user pkcs12`
- Root cause:
  - `ensureWorker()` timeout threw an exception that could surface to caller path before graceful fallback handling.

### Additional root cause discovered (model switch failure)

- Symptom:
  - model switch in web UI reported "request failed".
  - system journal showed frequent short-lived user-worker launches (open/close immediately).
- Deep cause:
  - user-worker command was launched with `cwd=/home/<user>`.
  - In this repo/runtime, invoking opencode entry from non-repo cwd exits immediately with code 0 (no `ready` event), causing repeated `WORKER_NOT_READY` on routed requests.

### Fix applied

- Worker launch context updated to repository runtime cwd:
  - `cwd = OPENCODE_USER_WORKER_CWD || process.cwd()`
  - instead of `cwd = userHome`
- This preserves user-home ownership via wrapper-injected `HOME/XDG_*`, while keeping worker runtime bootstrappable.

### Mitigation applied

- Increased worker readiness timeout (`8s` -> `20s`) to tolerate cold startup.
- `UserWorkerManager.call()` now catches worker bootstrap exceptions and returns structured error (`WORKER_NOT_READY`) instead of throwing.
- On readiness timeout, manager now terminates stale worker process and resets state before fallback path.

Result:

- Route handlers can continue using existing fallback behavior without exposing raw startup exception to UI.

### Additional hardening (prewarm)

- Added non-blocking prewarm in `UserWorkerManager` to reduce first-request cold-start failures:
  - `prewarm(username)` triggers background `ensureWorker()`.
  - dedupe via `prewarmInFlight`.
  - cooldown window (`30s`) via `lastPrewarmAt`.
- Gateway middleware now calls `UserWorkerManager.prewarm(requestUser)` when user-worker feature is enabled.
- New env control:
  - `OPENCODE_USER_WORKER_PREWARM` (default on, set `0` to disable)

Known issue visibility improvement:

- Prewarm failures are logged as `user worker prewarm failed` with username + error for debugging rollout hotspots.

## Phase 2-4 implementation (write-path pilot)

Expanded user-worker routing to selected mutation endpoints so account/config writes can follow authenticated user runtime context:

- Added RPC methods:
  - `config.update`
  - `account.setActive`
  - `account.remove`
  - `account.antigravityToggle`

- Worker handler (`user-worker` command) now executes these mutations in per-user process context.

- Gateway route pilot flags added:
  - `OPENCODE_USER_WORKER_ROUTE_CONFIG_UPDATE=1`
  - `OPENCODE_USER_WORKER_ROUTE_ACCOUNT_MUTATION=1`

- Route behavior when mutation pilot flags are ON:
  - On worker success: return normal response.
  - On worker failure: return `503` with structured error (`code/message`).
  - No silent fallback to legacy in-process writer for these paths (prevents cross-scope writes to service storage).

## Safety notes

- Do not run gateway as root.
- Do not grant broad ACL write to all `/home/*` for `opencode` user.
- Keep sudo policy narrowly scoped to wrapper executable.
