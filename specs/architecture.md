# Architecture

## System Overview

OpenCode is a desktop/TUI/Webapp multi-interface platform for interacting with AI coding agents and various model providers (OpenAI, Anthropic, Gemini, etc.).

## Core Architecture

- **Multi-Interface**: TUI (`cli/cmd/tui`), Desktop App, Webapp (`packages/app`), and CLI.
- **Unified Backend**: All interfaces communicate with a shared Node/Bun backend via the `@opencode-ai/sdk` or direct function calls.
- **Provider Abstraction**: Model interactions are abstracted through the `Provider` module, supporting multiple families (e.g., `google-api`, `anthropic`).

## Account Management (3-Tier Architecture)

- **Tier 1 (Storage)**: `packages/opencode/src/account/index.ts`. A pure repository interacting with `accounts.json`. Enforces unique IDs strictly (throws on collision).
- **Tier 2 (Unified Identity Service)**: `packages/opencode/src/auth/index.ts`. The central gateway for deduplicating identities (OAuth/API), resolving collisions, generating unique IDs, and orchestrating async background disposal (`Provider.dispose()`).
- **Tier 3 (Presentation)**: CLI (`accounts.tsx`), Admin TUI (`dialog-admin.tsx`), Webapp (`packages/app/src/components/settings-accounts.tsx`). Thin clients that _must_ route all account additions/deletions through Tier 2.

## Key Modules

- **`src/account`**: Disk persistence (`accounts.json`), ID generation, basic CRUD.
- **`src/auth`**: Identity resolution, OAuth token parsing, high-level API key addition, collision avoidance.
- **`src/provider`**: Manages active connections to model providers and their runtime instances.

## Account Bus Events

- **Event Types**: `account.added`, `account.removed`, `account.activated` — defined in `src/bus/index.ts`.
- **Sanitization**: `sanitizeInfo()` strips secrets (apiKey, refreshToken) before inclusion in bus event payloads.
- **Mutation Mutex**: All account mutations (`add`, `remove`, `setActive`, `update`) are serialized via an in-process Promise-chain mutex (`withMutex`) in `src/account/index.ts`, preventing concurrent race conditions on `accounts.json`.

## Data Flow (Account Deletion)

1. **User Request**: Triggered from TUI/Webapp.
2. **Optimistic UI**: Component removes account from local state immediately.
3. **Service Layer**: `Auth.remove()` calls `Account.remove()` (sync disk deletion).
4. **Background Cleanup**: `Auth.remove()` initiates a non-blocking promise to call `Provider.dispose()` and final disk save.
5. **Bus Event**: `Account.remove()` publishes `account.removed` via GlobalBus → SSE → all connected clients.

## Workspace Change Surfaces

- **Session-owned diff**: `GET /session/:sessionID/diff` returns the authoritative session-owned dirty diff for the current workspace. It is computed from session-owned candidate files intersected with current git-uncommitted state.
- **Workspace git status**: `GET /file/status` returns the whole workdir/project git status for the resolved directory.
- **UI boundary**:
  - Web/TUI session review flows may consume `session.diff` when the UX is explicitly about session-owned changes.
  - TUI sidebar `Changes` uses workspace-level git status (`file.status`) when the UX is explicitly about current workdir uncommitted files.
  - These two sources must not be silently conflated; session attribution and workdir cleanliness are separate contracts.

## Daemon Architecture (Multi-User Web Runtime)

### Overview

The web runtime supports a multi-user deployment model with process-level isolation:

```
Internet → [C Gateway :1080] → Unix Socket → [Per-User Daemon (uid=user)]
                                             → [Per-User Daemon (uid=user2)]
```

### Components

#### C Root Gateway (`daemon/opencode-gateway.c`)

- Runs as root, listens on TCP port (default :1080)
- **PAM Authentication**: Validates Linux credentials via `pam_authenticate`
- **JWT Sessions**: Issues HMAC-SHA256 JWT cookies (uid, username, exp) on successful auth
- **Per-User Daemon Spawning**: On first auth, `fork() → setgid() → setuid() → exec("opencode serve --unix-socket ...")`
- **splice() Proxy**: Zero-copy bidirectional forwarding between TCP client and per-user Unix socket using Linux `splice()` with intermediate pipe pairs
- **Registry**: In-memory UID → (pid, socket_path, state) mapping; SIGCHLD handler cleans up crashed daemons
- **Login Page**: Serves static HTML login form for unauthenticated requests

#### Per-User Daemon (`opencode serve --unix-socket`)

- Runs as the authenticated user's UID
- Listens on Unix socket at `$XDG_RUNTIME_DIR/opencode/daemon.sock`
- Full opencode server (API + SSE + WebSocket) available over Unix socket
- **Discovery File**: `$XDG_RUNTIME_DIR/opencode/daemon.json` — contains `{ socketPath, pid, startedAt, version }`
- **PID File**: `$XDG_RUNTIME_DIR/opencode/daemon.pid` — single-instance guard
- **Cleanup**: Removes discovery + PID files on SIGTERM/SIGINT/process exit; stale files detected and cleaned by `readDiscovery()`
- **Idle Timeout**: 120s TCP/Unix socket idle timeout via `Bun.serve({ idleTimeout: 120 })`

#### TUI Attach Mode (`opencode --attach`)

- Connects to an already-running per-user daemon via Unix socket
- **Auto-Spawn**: If no daemon is discovered, `Daemon.spawn()` launches a detached `opencode serve --unix-socket` child process, polls for `daemon.json` readiness (timeout 10s), then attaches
- **Discovery**: Reads `daemon.json`, validates PID alive (`kill -0`)
- **Custom Fetch**: `createUnixFetch(socketPath)` — routes HTTP requests over Unix socket
- **Custom SSE**: `createUnixEventSource(socketPath, baseUrl)` — streaming SSE client with manual line parsing over Unix socket fetch
- **Graceful Disconnect**: Ctrl+C closes SSE (AbortController) without affecting daemon

#### Daemon Coordination (Discovery-First)

- **Discovery file is truth, in-memory registry is cache**: Both TUI and C gateway use `daemon.json` as the canonical coordination point
- **TUI auto-spawn**: `--attach` → no daemon → `Daemon.spawn()` → daemon writes `daemon.json` → TUI attaches
- **Gateway adopt**: On web login, C gateway checks `daemon.json` before spawning a new daemon. If PID alive → adopt into registry → splice proxy. Covers daemons pre-spawned by TUI `--attach`
- **Race safety**: `daemon.pid` acts as single-instance guard; whoever creates the daemon first wins, latecomers discover and adopt

### SSE Event ID + Catch-up (Phase ζ)

- **Global Counter**: Monotonically increasing `_sseCounter` in `src/server/routes/global.ts`
- **Ring Buffer**: Array of `{ id, event }` entries (MAX_SIZE = 1000)
- **Reconnect**: Client sends `Last-Event-ID` header → server replays missed events from buffer
- **Buffer Overflow**: If `lastId` is older than buffer range → server sends `sync.required` event → client does full bootstrap refresh

### Security Migration (Phase δ)

- **Removed**: `LinuxUserExec`, `buildSudoInvocation`, `opencode-run-as-user.sh`, all sudo wrapper logic
- **Rationale**: Per-user daemon already runs as the correct UID; shell/PTY commands spawn directly without privilege escalation
- **Preserved**: Utility functions `sanitizeUsername`, `resolveLinuxUserHome`, `resolveLinuxUserUID` in `src/system/linux-user-exec.ts`

### Performance Hardening (Phase θ)

- **SDK LRU Cache**: `sdkSet()` in `src/provider/provider.ts` — Map-based FIFO eviction (MAX_SIZE = 50)
- **Server Idle Timeout**: 120s for both TCP and Unix socket modes

### Deployment (webctl.sh)

- `compile-gateway`: Compiles `daemon/opencode-gateway.c` via gcc
- `gateway-start`: Compiles + starts gateway daemon (nohup, PID file tracked)
- `gateway-stop`: Graceful SIGTERM → wait → SIGKILL fallback
- `install.sh --system-init`: Installs `opencode-gateway.service` + `opencode-user@.service` systemd units + gateway binary + login page
- **Coexistence**: Existing `dev-start`/`web-start` commands preserved unchanged; gateway is an additive deployment option

### systemd Units

- `opencode-gateway.service`: Root-level gateway daemon (`/usr/local/bin/opencode-gateway`)
- `opencode-user@.service`: Per-user daemon template (`/usr/local/bin/opencode serve --unix-socket ...`)
