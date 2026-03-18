# Design

## Context
Currently, the system manages accounts via `accounts.json` using the `Account` module (`src/account/index.ts`). However, the abstraction is leaky: business logic (like ID generation and collision suffixing) is mixed with storage operations. Furthermore, some interfaces (CLI, Admin TUI) bypass the higher-level `Auth.set` business logic entirely and call `Account.add` directly, missing deduplication checks. Finally, `Account.remove` executes synchronously and triggers heavy provider disposal, freezing the UI thread.

## Goals / Non-Goals
**Goals:**
- Implement a true 3-Tier Architecture for account management (Storage, Service, Presentation).
- Centralize all identity deduplication and collision resolution in the Service layer.
- Ensure the Storage layer (`Account.add`) is strictly a pure repository that throws on duplicate IDs.
- Fix UI freezes during account deletion by separating optimistic UI state updates from background async disposal.

**Non-Goals:**
- Changing the schema of `accounts.json` or breaking backward compatibility.
- Modifying how `Provider` instances execute requests or generate models.
- Rearchitecting the structure of the authentication payloads (OAuth/API).

## Decisions
- **Decision 1: 3-Tier Architecture**: We will establish a strict separation of concerns. 
  - Tier 1 (Storage): `Account` module (`src/account/index.ts`). Must throw errors if an `accountId` already exists.
  - Tier 2 (Unified Identity Service): `Auth` module (`src/auth/index.ts`) or a new `AccountManager`. Handles all deduplication (API/OAuth), ID collision resolution (generating `Default-1`), and orchestrating `Account.add`.
  - Tier 3 (Presentation): CLI, Webapp, TUI. They MUST call Tier 2 and are forbidden from calling Tier 1 directly.
- **Decision 2: Unified API Key Deduplication**: Just like OAuth checks the `refreshToken` base string, the Service layer must detect duplicate API keys. If a duplicate key is added under a new name, it should update the existing account or warn the user, rather than creating phantom duplicate instances.
- **Decision 3: Async Fire-and-Forget Deletion**: To prevent UI freezes, the presentation layer will optimistically update its state. The Service layer's `removeAccount` method will immediately delete the JSON entry (fast, synchronous) and fire a non-blocking background promise to handle `Provider.dispose()` and other slow cleanup tasks.

## Data / State / Control Flow
- **Add Request**: UI/CLI -> `Unified Service` -> `deduplicate(info)` -> `handleCollision(id)` -> `Account.insert(id)` -> `save(storage)` -> returns `finalId`.
- **Remove Request**: UI -> `optimistic local remove` -> `Unified Service.remove()` -> `Account.delete(id)` (Sync) -> Background Promise: `Provider.dispose(id)` & `save(storage)` (Async).

## Risks / Trade-offs
- Risk: Background disposal fails and leaves zombie instances. -> Mitigation: Wrap the background task in a `try/catch` and log errors heavily; the UI already considers the account deleted.
- Risk: Changing `Account.add` to throw on collision might break tests or plugins. -> Mitigation: Thoroughly update all call sites to use the Unified Service layer and run exhaustive `bun turbo typecheck` and `bun test`.
- Risk: TUI state mismatch after optimistic deletion. -> Mitigation: Ensure the in-memory state of `Account` is updated immediately before the UI component re-renders.

## Critical Files
- `packages/opencode/src/account/index.ts`
- `packages/opencode/src/auth/index.ts`
- `packages/opencode/src/cli/cmd/accounts.tsx`
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- `packages/opencode/src/cli/cmd/tui/component/dialog-account.tsx`
- `packages/opencode/src/server/routes/account.ts`
