# Event: Desktop Sidecar Simplification & XDG Frontend Deployment

Date: 2026-03-01
Status: Done
Branch: cms

## 1) Objective

Refactor the desktop Tauri app from a complex dual-process sidecar architecture to a thin native shell, and enable standalone offline `opencode web`/`opencode serve` by deploying frontend assets via XDG conventions.

## 2) Problems Solved

1. **Health-check polling race condition**: Old approach pre-allocated a port via `TcpListener` then released it (race window). Replaced with `--port 0` + stdout-based readiness detection.
2. **~1500 lines of Rust complexity**: Health-check loop, Job Object management, multi-step server URL fallback chain, loading window orchestration. Replaced with ~50 lines of stdout parsing.
3. **Desktop login form**: WebView loading web frontend would show login form. Solved via `window.__OPENCODE__.autoLoginCredentials` injected by Tauri initialization script.
4. **Offline webapp**: `opencode web`/`opencode serve` required internet for CDN proxy fallback. Now auto-detects frontend at `$XDG_DATA_HOME/opencode/frontend/`.

## 3) Changes

### Phase 1: Architecture documentation
- `docs/ARCHITECTURE.md` — added section 21 documenting desktop runtime architecture
- `packages/desktop/src/bindings.ts` — reverted Gemini's corruption to HEAD

### Phase 2: Simplify sidecar launch (Rust)
- `src-tauri/src/cli.rs` — `SERVER_READY_PREFIX` constant, stdout-based readiness via oneshot channel, `OPENCODE_FRONTEND_PATH` env for bundled resource
- `src-tauri/src/server.rs` — removed `spawn_local_server()`, `HealthCheck` struct, unused imports
- `src-tauri/src/lib.rs` — simplified `initialize()`, made `ServerReadyData` pub(crate), removed `event_once_fut`

### Phase 3: Switch frontend to web entry
- `src-tauri/src/windows.rs` — `MainWindow::create()` now takes `&ServerReadyData`, uses `WebviewUrl::External(url)`, injects auto-login credentials via init script
- `packages/app/src/components/auth-gate.tsx` — added `onMount` hook to read `window.__OPENCODE__.autoLoginCredentials` and call `auth.login()`

### Phase 4: Build pipeline alignment
- `src-tauri/tauri.conf.json` — added `resources: { "../../app/dist": "frontend" }`, updated `beforeBuildCommand`

### Phase 5: XDG frontend deployment
- `packages/opencode/src/global/index.ts` — added `Global.Path.frontend`
- `packages/opencode/src/server/app.ts` — added `resolveXdgFrontend()` cached resolver, fallback chain: env → XDG → CDN
- `scripts/install/install` — added `download_and_install_frontend()` to download and extract `opencode-frontend.tar.gz`
- `script/build.ts` — added frontend build + tarball creation (`opencode-frontend.tar.gz`) to release pipeline

## 4) Frontend Serving Fallback Chain

```
1. OPENCODE_FRONTEND_PATH env var (explicit override)
   ↓ (not set)
2. $XDG_DATA_HOME/opencode/frontend/ (auto-detected, cached once per process)
   ↓ (not found)
3. Proxy to https://app.opencode.ai (internet fallback)
```

## 5) Validation

- `cargo check` in `src-tauri/` — zero warnings
- Architecture doc section 21 updated to reflect refactored state
- Install script gracefully falls back if frontend tarball not yet published

## 6) XDG Layout (post-install)

```
~/.local/share/opencode/
├── bin/opencode          ← CLI binary
├── frontend/             ← pre-built app dist
│   ├── index.html
│   └── assets/
├── skills/
├── log/
└── ...
```
