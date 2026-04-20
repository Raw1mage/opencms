# Handoff: safe-daemon-restart

## Execution Contract

Implementing agent MUST:

1. Follow `specs/safe-daemon-restart/tasks.md` phase-by-phase; never batch check-boxes at end
2. Check each `- [ ]` → `- [x]` immediately upon task completion; run `plan-sync.ts` after each
3. Phase boundaries = rhythmic checkpoint (write slice summary to `docs/events/`), not user-prompt gate
4. Work on **beta worktree** (`~/projects/opencode-beta`), NOT directly on main repo (per `beta-workflow` skill)
5. Back up XDG config (`~/.config/opencode/`) BEFORE first build/test command (per opencode AGENTS.md)

## Required Reads

Before writing any code, agent MUST read:

- `specs/safe-daemon-restart/spec.md` — all requirements + acceptance checks
- `specs/safe-daemon-restart/design.md` — decisions DD-1..DD-8
- `specs/safe-daemon-restart/data-schema.json` — request/response shapes
- `specs/safe-daemon-restart/errors.md` — error code catalogue
- `daemon/opencode-gateway.c` lines 715-770 (`resolve_runtime_dir`), 1491-1691 (`ensure_daemon_running`)
- `packages/mcp/system-manager/src/index.ts` lines 417-466 (tools array), 825-870 (execute_command handler)
- `AGENTS.md` (project root) — opencode-specific XDG backup rule
- `~/.config/opencode/AGENTS.md` — global no-silent-fallback rule

## Stop Gates In Force

Stop and consult user BEFORE:

- **Gate G1** Changing gateway HTTP dispatch structure (phase 2.1) — design review if restructuring beyond adding one route
- **Gate G2** Modifying `AGENTS.md` / `templates/AGENTS.md` wording (phase 5.1, 5.4) — user should approve exact wording
- **Gate G3** Any deviation from `data-schema.json` — contract is frozen; scope creep requires `amend` mode
- **Gate G4** If flock holder detection requires kernel features unavailable on WSL2 — fall back to `ss -xlp` path, but escalate if both fail
- **Gate G5** If integration test fails for TV-5 (orphan cleanup) three times → stop, re-read design DD-3, do not hack around

Stop gates NOT in force (proceed autonomously):

- Routine task-to-task transitions
- Code refactoring within a single file
- Log message wording (use spec observability.md as guideline)

## Execution-Ready Checklist

Before the build agent starts:

- [ ] `specs/safe-daemon-restart/.state.json.state == "planned"`
- [ ] XDG backup taken: `~/.config/opencode.bak-<timestamp>-safe-daemon-restart/`
- [ ] Beta worktree exists: `~/projects/opencode-beta` checked out on `beta/safe-daemon-restart-<date>`
- [ ] bun + gcc available (`bun --version`, `cc --version`)
- [ ] `opencode-gateway` binary source compiles cleanly before edits: `cd daemon && make` (or equivalent)
- [ ] Current gateway log baseline captured: `sudo journalctl -u opencode-gateway -n 100 > /tmp/gateway-baseline.log`

## Execution Evidence

Captured 2026-04-21 during test-branch acceptance.

**Commits (test/safe-daemon-restart = main + 6):**
- `80a03a0d8` phase 1 — gateway runtime-dir guarantee + orphan cleanup (C)
- `7590acc3c` revise — webctl integration
- `16dddb770` phase 2+3 — /web/restart gateway-daemon + MCP restart_self
- `062715d1d` phase 4+5 — bash denylist + AGENTS/architecture/incident doc
- `0f2a66f67` tasks.md phase 5 close
- `a17d963bb` Merge beta into test

**Gateway rebuild:** `cd daemon && make clean && make` → 102064 bytes, 0 errors. `sudo install -m 4755 -o root daemon/opencode-gateway /usr/local/bin/`. `sudo systemctl restart opencode-gateway` → active.

**TV-1** (endpoint reachable): `curl POST /api/v2/global/web/restart` (no cookie) → 401 `{"error":"unauthorized"}`. Full positive path requires logged-in browser (UI Settings → Restart Web); covered by existing UI flow.

**TV-2** (SIGKILL escalation): `daemon/test-orphan-cleanup.c` `test_cleanup_escalates_to_sigkill` — child installs `signal(SIGTERM, SIG_IGN)` + `pause()`, cleanup SIGTERMs then escalates SIGKILL after 1000ms, child gone within 500ms. Pass.

**TV-3 / TV-4** (denylist): `bun test packages/opencode/src/tool/bash-denylist.test.ts` — 14/14 pass, 16 expect calls. Blocks webctl.sh restart-family, bun serve --unix-socket, opencode serve, indirect kill, systemctl restart opencode-gateway. Allows git/ls/bun-build/plain-kill passthrough.

**TV-5 + TV-6 + TV-7** (live end-to-end):
```
Apr 21 01:45:42 [WARN ] orphan-detected uid=1000 holderPid=945205 username=pkcs12 — cleaning up before spawn
Apr 21 01:45:42 [INFO ] orphan-cleanup uid=1000 holderPid=945205 result=exited waitedMs=50 username=pkcs12
Apr 21 01:45:42 [INFO ] runtime-dir-created path=/run/user/1000/opencode uid=1000 mode=0700
Apr 21 01:45:42 [INFO ] spawning daemon for pkcs12 (uid 1000) socket='/run/user/1000/opencode/daemon.sock'
Apr 21 01:45:42 [INFO ] forked daemon child for pkcs12: pid=945805
```
Setup: killed prior daemon, `sudo rm -rf /run/user/1000/opencode/`, `curl /api/v2/global/health` → status 200. User session continuous; no JWT clear, no login redirect. Contrast with 2026-04-20 failure mode which looped `waitpid ECHILD` until JWT cleared.

**Final state transition timestamp:** pending user approval for test → main finalize.
