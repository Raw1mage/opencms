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
- **Tier 3 (Presentation)**: CLI (`accounts.tsx`), Admin TUI (`dialog-admin.tsx`), Webapp (`packages/app/src/components/settings-accounts.tsx`). Thin clients that *must* route all account additions/deletions through Tier 2.

## Key Modules
- **`src/account`**: Disk persistence (`accounts.json`), ID generation, basic CRUD.
- **`src/auth`**: Identity resolution, OAuth token parsing, high-level API key addition, collision avoidance.
- **`src/provider`**: Manages active connections to model providers and their runtime instances.

## Data Flow (Account Deletion)
1. **User Request**: Triggered from TUI/Webapp.
2. **Optimistic UI**: Component removes account from local state immediately.
3. **Service Layer**: `Auth.remove()` calls `Account.remove()` (sync disk deletion).
4. **Background Cleanup**: `Auth.remove()` initiates a non-blocking promise to call `Provider.dispose()` and final disk save.
