# Event — Self-Restart Handover Checkpoint

## Requirement

User clarified that self-restart must persist a durable handover file because gateway/daemon interruption can break the socket and lose AI turn memory.

## Scope

### In

- Design and implement a restart handover checkpoint before controlled self-restart.
- Ensure restart result reporting does not treat socket close as success.
- Preserve continuation evidence without secrets.

### Out

- Bash daemon restart/spawn paths.
- Secret-bearing snapshots.

## Task List

- `plans/20260505_self_restart_handover/tasks.md`.

## Debug Checkpoints

- Baseline: `system-manager_restart_self` returned `socket connection was closed unexpectedly`; this is ambiguous between successful restart interruption and failed request.
- Initial root concern: current restart flow lacks a durable handover file that survives daemon/gateway interruption.
- Boundary evidence: `packages/mcp/system-manager/src/index.ts` previously only posted `/global/web/restart`; `packages/opencode/src/server/routes/global.ts` generated txid inside the daemon and then invoked webctl/self-update. If the socket closed before response parsing, AI had neither txid nor handover path.
- Existing restart audit (`packages/opencode/src/server/self-update.ts`) records privileged action results only; it does not preserve active AI session continuation context.
- Follow-up baseline: `restart_self` after frontend changes built `packages/app/dist` successfully, then failed syncing to `/usr/local/share/opencode/frontend` with `Read-only file system (30)`. Manual shell `webctl.sh restart` can work because the operator shell has sudo interaction/timestamp, while daemon-triggered restart must be non-interactive.
- WebApp restart button regression baseline: user reported the Settings/WebApp restart button "按了就關掉". Boundary evidence: the button calls `/global/web/restart`; in gateway-daemon mode the route previously executed and awaited `webctl.sh restart --graceful` inside the HTTP handler. `webctl.sh restart` can reload/terminate the current per-user daemon before the handler sends a response, so the browser observes a closed connection rather than an accepted restart contract.
- Daemon startup evidence baseline: user clarified that restart memory must include restart records, or daemon startup must write a durable log. Existing handover recorded intent before restart but did not prove that a new daemon process actually started after gateway respawn.
- Follow-up evidence: after the user ran repo `./webctl.sh restart`, health was green and the per-user daemon process showed `/home/pkcs12/projects/opencode/packages/opencode/src/index.ts serve --unix-socket /run/user/1000/opencode/daemon.sock`, but no `daemon-startup/startup.jsonl` existed. This proved the initial startup hook was placed on the wrong CLI entry (`web`), while gateway-spawned per-user daemons use `serve --unix-socket`.

## Root Cause

Self-restart had a durability gap between AI intent and gateway-owned restart execution. The restart endpoint could safely rebuild/restart the daemon, but the initiating AI turn relied on in-memory context and a live socket response. Gateway/daemon interruption made the result unknowable and could lose the continuation instructions.

Follow-up root cause: gateway-daemon `restart_self` invoked `webctl.sh restart` from a non-interactive daemon. The frontend sync path previously selected plain `sudo` only from writability probes, which can differ between an interactive operator shell and daemon context. The correct privilege boundary is an explicit `/etc/sudoers.d/` allowlist for fixed commands plus `sudo -n` fail-fast behavior, not general or interactive sudo.

WebApp restart button root cause: gateway-daemon restart treated `webctl.sh restart` as a synchronous child command even though that command is allowed to terminate/reload the daemon serving the HTTP request. The UI needs an `accepted` response plus health polling before daemon shutdown begins; waiting in-handler creates an expected race where the transport closes first.

Daemon startup evidence root cause: restart handover was one-sided. A pre-restart checkpoint can preserve AI continuation context, but without a post-start daemon event there is no durable causal link from `txid` to the new process that accepted requests after respawn.

Startup hook placement root cause: the post-start recorder was attached to `packages/opencode/src/cli/cmd/web.ts`, but gateway-spawned per-user daemons run `ServeCommand` in Unix socket mode (`Server.listenUnix(socketPath)`). Repo `webctl restart` also bypasses `/global/web/restart`, so it must write its own restart marker before scheduling the detached restart worker.

## Implementation

- Added `packages/opencode/src/server/restart-handover.ts` to write redacted JSON checkpoints under `Global.Path.state/restart-handover/<txid>.json`.
- `/global/web/restart` now accepts optional `txid`, `sessionID`, and `handover`; it writes the checkpoint before invoking webctl or privileged self-update actions and returns `handoverPath` on accepted requests.
- `system-manager_restart_self` now writes a preflight checkpoint before HTTP POST, sends the same txid to the daemon, and reports `status unknown` plus checkpoint path if the socket closes.
- `specs/architecture.md` records the controlled self-restart handover boundary.
- Follow-up: `packages/opencode/src/server/routes/global.ts` now sets `OPENCODE_FORCE_SUDO_FRONTEND_SYNC=1` when gateway-daemon restart invokes `webctl.sh`.
- Follow-up: `webctl.sh` treats `OPENCODE_FORCE_SUDO_FRONTEND_SYNC=1` as an explicit privileged deployment boundary and runs frontend target preparation/sync through `sudo -n`, so missing `/etc/sudoers.d/` permission fails fast instead of prompting or silently trying a non-privileged rsync.
- Required sudoers shape: grant only fixed commands needed by restart deployment, e.g. `rsync` for `/usr/local/share/opencode/frontend`, `install` for `/etc/opencode/webctl.sh` and `/usr/local/bin/opencode-gateway`, and `systemctl restart opencode-gateway.service`; do not grant arbitrary shell or full `webctl.sh` sudo.
- Operator install helper: added `scripts/install-opencode-restart-sudoers.sh`. It resolves command paths from the local system, generates `/etc/sudoers.d/opencode-restart` for the current user (override with `OPENCODE_RESTART_SUDO_USER=...`), validates with `visudo`, backs up an existing sudoers fragment, and installs mode `0440`.
- WebApp restart button fix: gateway-daemon `/global/web/restart` now writes the restart handover, spawns `webctl.sh restart --graceful` as a background process with `OPENCODE_FORCE_SUDO_FRONTEND_SYNC=1`, immediately returns the accepted restart payload, and leaves the frontend to poll `/api/v2/global/health` for recovery. Missing `webctl.sh` still fails before acceptance.
- Daemon startup evidence: `RestartHandover.write()` now also writes `Global.Path.state/restart-handover/pending.json` pointing at the latest restart checkpoint. Added `packages/opencode/src/server/daemon-startup-log.ts`; `packages/opencode/src/cli/cmd/web.ts` appends `Global.Path.state/daemon-startup/startup.jsonl` after `Server.listen(...)` succeeds, including pid/ppid/uid, launch mode, daemon mode, port/hostname, and the pending restart txid/checkpoint path when present.
- Follow-up: `packages/opencode/src/cli/cmd/serve.ts` now records daemon startup evidence after both `Server.listenUnix(socketPath)` and TCP `Server.listen(...)`, and `DaemonStartupLog.Record` includes `socketPath`. Repo `webctl.sh restart` and `templates/webctl.sh` now write `restart-handover/<txid>.json` plus `pending.json` before scheduling the detached worker, so terminal-initiated repo restarts produce the same marker that the next daemon startup can link to.

## Validation

- `bun test --timeout 15000 packages/opencode/test/server/restart-handover.test.ts` passed (2 tests, 8 assertions).
- `bun run --cwd packages/opencode typecheck` still fails on existing baseline errors outside this slice (`opencode-codex-provider`, CLI command arity, TUI `sessionId`, existing `server/routes/session.ts`, `message-v2.ts`, `share-next.ts`, etc.).
- `bun run --cwd packages/mcp/system-manager typecheck` still fails on existing workspace baseline (`@opencode-ai/console-function` missing `sst`), before this specific MCP helper can be isolated by package typecheck.
- Manual restart smoke is not run in this turn; future restart calls should pass `sessionID`/`handover` and then verify `handoverPath` or preflight checkpoint after reconnect.
- Follow-up validation: `bash -n webctl.sh` passed.
- Follow-up validation: `bun --filter @opencode-ai/app typecheck` passed and focused eslint for `packages/app/src/pages/session.tsx`, `packages/app/src/pages/session/message-timeline.tsx`, and `packages/ui/src/components/session-turn.tsx` passed, preserving the concurrent mobile filetab-link work.
- Follow-up validation: `bun run --cwd packages/opencode typecheck` still fails on existing baseline errors outside this slice; no new diagnostic points to the `OPENCODE_FORCE_SUDO_FRONTEND_SYNC` route env change.
- Restart smoke is intentionally deferred until `/etc/sudoers.d/` grants the fixed `sudo -n` commands; without that allowlist the expected behavior is fail-fast, not fallback.
- Sudoers install attempt: generated a narrow `/etc/sudoers.d/opencode-restart` candidate and `visudo -c -f` parsed it OK, but `sudo install -m 0440 ... /etc/sudoers.d/opencode-restart` failed with `Read-only file system`. Gateway service restart allowlist was not installed by AI because shell denylist blocks commands containing direct gateway restart control; that line must be applied by an operator or sanctioned non-AI path.
- Operator helper validation: `chmod +x scripts/install-opencode-restart-sudoers.sh && bash -n scripts/install-opencode-restart-sudoers.sh` passed. The script is intended for manual execution by sudoer user `pkcs12`: `./scripts/install-opencode-restart-sudoers.sh`.
- Operator restart confirmation: user reported running `webctl.sh restart` from an interactive terminal after the AI-side sudo install was blocked. This confirms the manual deployment path was exercised outside the daemon-owned `restart_self` channel; source changes remain uncommitted in the repo working tree pending final commit.
- WebApp restart button validation: focused lint for `packages/opencode/src/server/routes/global.ts` passed. `bun run --cwd packages/opencode typecheck` remains blocked by existing baseline diagnostics outside this route; no new diagnostic points to the background-spawn restart change. Runtime smoke still requires deploying the current source (for example via operator `webctl.sh restart`) before pressing the WebApp restart button again.
- Daemon startup evidence validation: `bun test --timeout 15000 packages/opencode/test/server/restart-handover.test.ts packages/opencode/test/server/daemon-startup-log.test.ts` passed (3 tests, 15 assertions). Focused eslint for `packages/opencode/src/server/restart-handover.ts`, `packages/opencode/src/server/daemon-startup-log.ts`, `packages/opencode/src/cli/cmd/web.ts`, and `packages/opencode/src/cli/cmd/serve.ts` passed. `bash -n webctl.sh && bash -n templates/webctl.sh` passed.

## Backup

- XDG whitelist backup: `~/.config/opencode.bak-20260505-self-restart-handover/`.
- Follow-up XDG whitelist backup: `~/.config/opencode.bak-20260505-1538-self-restart-sudo/`.
- Follow-up XDG whitelist backup: `~/.config/opencode.bak-20260505-1701-daemon-startup-log/`.
