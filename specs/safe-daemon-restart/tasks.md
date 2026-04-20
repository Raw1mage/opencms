# Tasks: safe-daemon-restart

## 1. Gateway runtime-dir guarantee + orphan cleanup (C)

- [x] 1.1 Extend `resolve_runtime_dir()` in `daemon/opencode-gateway.c` to also `mkdir + chown + chmod 0700` the `opencode/` subdir (`/run/user/<uid>/opencode/`) before returning — new helper `ensure_socket_parent_dir(uid, gid)` called from `ensure_daemon_running` BEFORE fork
- [x] 1.2 Add `detect_lock_holder_pid(username, target_uid)` helper — **design amended**: gateway lock is a PID JSON file at `~/.config/opencode/daemon.lock` (not kernel flock); detector reads file, verifies `/proc/<pid>` uid matches target. Returns pid or -1.
- [x] 1.3 Add `cleanup_orphan_daemon(pid, username)` helper: SIGTERM → poll `kill(pid,0)` for 1000ms → SIGKILL if still alive → log `orphan-cleanup uid=... holderPid=... result=...`
- [x] 1.4 Wire orphan cleanup into `ensure_daemon_running`: after `adopt failed`, before `fork`, call detect → if holder found AND uid matches → cleanup → then proceed
- [x] 1.5 Unit test (C-level): `daemon/test-orphan-cleanup.c` covers detect(alive/stale/no-file) + cleanup(SIGTERM/SIGKILL escalation); all 9 assertions pass

## 2. Extend /web/restart gateway-daemon branch to run webctl rebuild (TypeScript)

Scope **revised 2026-04-21**: `/api/v2/global/web/restart` already exists (`packages/opencode/src/server/routes/global.ts`) and handles legacy-mode with webctl.sh rebuild. Gateway-daemon mode currently just self-terminates without rebuild. This phase closes that gap.

- [x] 2.1 In `packages/opencode/src/server/routes/global.ts` line ~511-533 (gateway-daemon branch): before the self-terminate setTimeout, call `webctl.sh restart --graceful` via `Bun.spawn` (same pattern as legacy branch line ~535-595)
- [x] 2.2 On webctl exit != 0: do NOT self-terminate; return 5xx with error log path + hint (mirrors legacy error path); preserves "rebuild failed → system stays on old version" invariant
- [x] 2.3 Accept optional `targets?: ("daemon"|"frontend"|"gateway")[]` body parameter; when `gateway` is requested, append `--force-gateway` to the webctl call
- [x] 2.4 Webctl lock busy (stderr matches `/already in progress/`) → return 409 `RESTART_LOCK_BUSY`
- [x] 2.5 Structured logs at 3 checkpoints: `invoking webctl` (INFO), `webctl failed` (ERROR), `webctl ok, scheduling self-terminate` (INFO) — all include txid, targets, webctlExit
- [>] 2.6 Integration smoke test — **deferred to Phase 6 TV-1**: full end-to-end needs running daemon + gateway + webctl; covered in manual verification phase with other acceptance vectors

## 3. system-manager MCP restart_self tool (TypeScript)

Scope **simplified**: no new endpoint needed — tool just POSTs the existing `/web/restart`.

- [x] 3.1 Added `restart_self` tool schema to tools array (line ~571) with `targets?` and `reason?` + explicit description warning about `--force-gateway` disconnect
- [x] 3.2 Handler at end of dispatch: uses `serverFetch` via unix socket (same pattern as `remove_mcp_app`); forwards targets + reason
- [x] 3.3 Success → text describing mode + txid + reconnect expectation; error → preserves `code`, `hint`, `errorLogPath` from endpoint
- [x] 3.4 No fallback — endpoint error surfaced as isError text; no retry, no spawn
- [>] 3.5 Unit test — **deferred to Phase 6 TV-1 / TV-2**: end-to-end via real daemon gives stronger signal than mock

## 4. system-manager execute_command denylist (TypeScript)

- [ ] 4.1 Introduce `DAEMON_SPAWN_DENYLIST` constant array of regex in system-manager: patterns for `webctl\.sh\s+(dev-start|dev-refresh|dev-stop)`, `\bbun\b.*\bserve\b.*--unix-socket`, `\bopencode\s+(serve|web)\b`, `\bkill\b.*<daemon-pid-pattern>`
- [ ] 4.2 In `execute_command` handler, match input against denylist BEFORE template lookup or shell exec; on match throw error with code `FORBIDDEN_DAEMON_SPAWN` and message referencing `restart_self`
- [ ] 4.3 Emit `denylist-block rule=... argvHash=...` log line (warn level)
- [ ] 4.4 Unit test vectors TV-3 and TV-4; also negative test that legitimate commands (e.g. `git status`) pass through

## 5. Policy + docs

- [x] 5.1 `AGENTS.md`: added "Daemon Lifecycle Authority" section after XDG backup rule
- [x] 5.2 `specs/architecture.md`: appended "Daemon Lifecycle Authority" section
- [x] 5.3 `docs/events/event_2026-04-20_daemon-orphan.md`: full RCA + timeline + fix summary
- [x] 5.4 `templates/AGENTS.md`: new rule 11 mirrors project AGENTS.md

## 6. Acceptance validation

- [ ] 6.1 Run TV-1 through TV-7 end-to-end on a beta worktree; capture outputs
- [ ] 6.2 Manual verification: artificially create orphan (spawn bun daemon out-of-band), trigger request, confirm gateway log shows orphan-cleanup path, user not redirected to login
- [ ] 6.3 Manual verification: `sudo rm -rf /run/user/1000/opencode/` then access site; confirm auto-recreate + normal operation
- [ ] 6.4 Record validation evidence in `handoff.md` under Execution Evidence section
- [ ] 6.5 Promote state verified → living after fetch-back to main
