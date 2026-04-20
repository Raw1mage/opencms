# Tasks: safe-daemon-restart

## 1. Gateway runtime-dir guarantee + orphan cleanup (C)

- [x] 1.1 Extend `resolve_runtime_dir()` in `daemon/opencode-gateway.c` to also `mkdir + chown + chmod 0700` the `opencode/` subdir (`/run/user/<uid>/opencode/`) before returning — new helper `ensure_socket_parent_dir(uid, gid)` called from `ensure_daemon_running` BEFORE fork
- [x] 1.2 Add `detect_lock_holder_pid(username, target_uid)` helper — **design amended**: gateway lock is a PID JSON file at `~/.config/opencode/daemon.lock` (not kernel flock); detector reads file, verifies `/proc/<pid>` uid matches target. Returns pid or -1.
- [x] 1.3 Add `cleanup_orphan_daemon(pid, username)` helper: SIGTERM → poll `kill(pid,0)` for 1000ms → SIGKILL if still alive → log `orphan-cleanup uid=... holderPid=... result=...`
- [x] 1.4 Wire orphan cleanup into `ensure_daemon_running`: after `adopt failed`, before `fork`, call detect → if holder found AND uid matches → cleanup → then proceed
- [x] 1.5 Unit test (C-level): `daemon/test-orphan-cleanup.c` covers detect(alive/stale/no-file) + cleanup(SIGTERM/SIGKILL escalation); all 9 assertions pass

## 2. Gateway restart-self HTTP endpoint (C)

- [ ] 2.1 Add route handler for `POST /api/v2/global/restart-self` in gateway HTTP dispatch: validate JWT, extract uid, generate `eventId` (UUID v4)
- [ ] 2.2 Return `202 Accepted` immediately with `{accepted, eventId, targetPid, scheduledAt}` JSON (see `data-schema.json:RestartSelfResponse`)
- [ ] 2.3 Schedule async restart: push job onto gateway event loop queue → SIGTERM → 2s waitpid → SIGKILL if needed → `unlink(socket_path)` → `DaemonInfo.state = NONE`
- [ ] 2.4 During restart window (state=RESTARTING), return `503 {retryAfter: "2s"}` for that uid's new HTTP requests instead of triggering a parallel spawn
- [ ] 2.5 Emit structured logs: `restart-self uid=... targetPid=... eventId=... reason=...` + `restart-sigkill` on escalation
- [ ] 2.6 Add integration test: curl endpoint with valid JWT, assert 202 + pid change + no user redirect

## 3. system-manager MCP tool (TypeScript)

- [ ] 3.1 Add `restart_self` tool to `packages/mcp/system-manager/src/index.ts` tools array; schema matches `data-schema.json:RestartSelfRequest`; description emphasises AI should only call this when restart is explicitly needed (config reload, stuck state)
- [ ] 3.2 Tool handler: HTTP POST to `http://localhost:1080/api/v2/global/restart-self` (or unix-socket equivalent) with current session JWT (read from daemon-side env `OPENCODE_SESSION_JWT` or gateway header passthrough); return `{restartScheduled, eventId}` to AI
- [ ] 3.3 Handle tool-side edge: if POST fails before 202 (connection refused) return error with actionable message; do NOT attempt any local spawn as fallback
- [ ] 3.4 Unit test: mock gateway endpoint, assert tool correctly forwards JWT, returns eventId, handles non-202 as error

## 4. system-manager execute_command denylist (TypeScript)

- [ ] 4.1 Introduce `DAEMON_SPAWN_DENYLIST` constant array of regex in system-manager: patterns for `webctl\.sh\s+(dev-start|dev-refresh|dev-stop)`, `\bbun\b.*\bserve\b.*--unix-socket`, `\bopencode\s+(serve|web)\b`, `\bkill\b.*<daemon-pid-pattern>`
- [ ] 4.2 In `execute_command` handler, match input against denylist BEFORE template lookup or shell exec; on match throw error with code `FORBIDDEN_DAEMON_SPAWN` and message referencing `restart_self`
- [ ] 4.3 Emit `denylist-block rule=... argvHash=...` log line (warn level)
- [ ] 4.4 Unit test vectors TV-3 and TV-4; also negative test that legitimate commands (e.g. `git status`) pass through

## 5. Policy + docs

- [ ] 5.1 Add to `AGENTS.md` (top-level rules section): 「AI 禁止自行 spawn / kill / restart daemon 行程；restart 必須透過 `restart_self` tool，否則違規」
- [ ] 5.2 Add section to `specs/architecture.md`: "Daemon Lifecycle Authority" — gateway is the sole owner; daemon never forks/execs another daemon; AI never invokes daemon-spawning commands
- [ ] 5.3 Write `docs/events/event_2026-04-20_daemon-orphan.md` capturing the incident RCA, fix summary, and link to this spec package
- [ ] 5.4 Update `templates/AGENTS.md` to mirror the new rule (release sync per §Release 前檢查清單)

## 6. Acceptance validation

- [ ] 6.1 Run TV-1 through TV-7 end-to-end on a beta worktree; capture outputs
- [ ] 6.2 Manual verification: artificially create orphan (spawn bun daemon out-of-band), trigger request, confirm gateway log shows orphan-cleanup path, user not redirected to login
- [ ] 6.3 Manual verification: `sudo rm -rf /run/user/1000/opencode/` then access site; confirm auto-recreate + normal operation
- [ ] 6.4 Record validation evidence in `handoff.md` under Execution Evidence section
- [ ] 6.5 Promote state verified → living after fetch-back to main
