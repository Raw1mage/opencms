# Phase 1 — Gateway runtime-dir guarantee + orphan cleanup (C)

Plan: `specs/safe-daemon-restart/`
Branch: `beta/safe-daemon-restart-20260421` on `/home/pkcs12/projects/opencode-beta`
Date: 2026-04-21

## Done

- 1.1 `ensure_socket_parent_dir(uid, gid, socket_path)` helper + call site in `ensure_daemon_running`
- 1.2 `detect_lock_holder_pid(username, target_uid)` helper — reads `~/.config/opencode/daemon.lock` JSON, verifies `/proc/<pid>` uid
- 1.3 `cleanup_orphan_daemon(pid, username, target_uid)` helper — SIGTERM → 1000ms poll → SIGKILL → 500ms reap
- 1.4 Wired detect + cleanup into `ensure_daemon_running` after `adopt failed`, before fork
- 1.5 `daemon/test-orphan-cleanup.c` — 5 test scenarios, 9 assertions, all pass

## Key decisions

- **DD-3b** (supersedes DD-3): gateway lock is a PID JSON file, not kernel flock. Detector reads JSON, not `fcntl(F_OFD_GETLK)`. Discovered during implementation; design amended in place.
- Added `waitpid(pid, NULL, WNOHANG)` to poll loops in cleanup_orphan_daemon — harmless ECHILD if not our child; prevents polling a zombie forever if it is.

## Validation

- `make clean && make` in `daemon/`: 0 errors, only pre-existing `-Wpedantic` warnings
- `make test` → all assertions pass (see tail of phase 1 run)

## Drift

Design drift on DD-3 noted above; amended in `design.md` with version marker. No downstream spec impact (RESTART-003 requirement text is still correct; only mechanism changed).

## Remaining

Phase 2 — Gateway restart-self HTTP endpoint (C).
