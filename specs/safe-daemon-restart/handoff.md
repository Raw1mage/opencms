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

(Fill during `verified` state promotion.)

- Commit SHAs:
- Gateway rebuild evidence:
- TV-1..TV-7 outputs:
- Manual verification screencaps / log excerpts:
- Final state transition timestamp:
