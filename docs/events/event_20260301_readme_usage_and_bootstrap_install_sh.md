# Event: add README usage guide and bootstrap install.sh

Date: 2026-03-01
Status: Done

## Scope

- Expand root `README.md` with practical usage instructions.
- Add a root-level `install.sh` for newcomer environment bootstrap.

## Changes

1. README usage coverage added:
   - Prerequisites section (bun / git / curl + desktop note)
   - `install.sh` quickstart and flags (`--with-desktop`, `--skip-system`, `--yes`)
   - Startup and usage instructions for:
     - TUI (`bun run dev`)
     - Web app (`webctl.sh build-frontend/start/status/logs/stop`)
     - Desktop (`bun run --cwd packages/desktop tauri dev`)

2. New root script `install.sh`:
   - Detects OS and common package managers (brew/apt/dnf/pacman)
   - Installs baseline dependencies (best effort)
   - Installs Bun if missing
   - Runs `bun install`
   - Builds `packages/app` for web frontend readiness
   - Supports optional desktop prerequisite path (`--with-desktop`)

## Rationale

- New contributors need a deterministic onboarding path from zero to runnable local environment.
- README now serves both architecture orientation and hands-on operation guide.
