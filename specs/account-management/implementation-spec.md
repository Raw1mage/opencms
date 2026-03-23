# Implementation Spec

## Goal
- Architect a true 3-Tier Account Management framework (Storage, Identity Service, Presentation) that centralizes deduplication/collision logic, prevents silent overwrites via a strict storage repository, and provides non-blocking account deletion for responsive UI.

## Scope
### IN
- **Tier 1 (Storage)**: Restrict `Account.add` to pure, synchronous insertion. It MUST throw if an `accountId` already exists.
- **Tier 2 (Unified Identity Service)**: Establish a centralized gateway (e.g., `Auth` module) that handles identity deduplication (OAuth/API), resolves ID collisions (generating `Default-1`), and orchestrates async background cleanup (Provider disposal) to free the UI thread.
- **Tier 3 (Presentation)**: Refactor CLI (`accounts.tsx`), Admin TUI (`dialog-admin.tsx`), Webapp API (`server/routes/account.ts`), and TUI (`dialog-account.tsx`) to strictly route through Tier 2.

### OUT
- Adding new authentication providers (e.g., Apple, Google Workspace).
- Changing the basic structure or location of `accounts.json` on disk.
- Refactoring `Provider` instance execution internals (except its disposal trigger).

## Assumptions
- `Account.add` is currently treating `accounts.json` as a mutable dictionary, silently overwriting colliding IDs. Making it throw will require careful migration of all its callers.
- The UI freeze during account deletion is directly caused by synchronous operations like `Provider.dispose()` or slow disk `save(storage)` calls that block the event loop.

## Stop Gates
- Need approval if making `Account.add` throw causes widespread, difficult-to-resolve test failures in plugins or tests that mock/bypass the service layer.
- Need approval if the async fire-and-forget disposal introduces unexpected zombie background processes or memory leaks that are hard to trace.

## Critical Files
- `packages/opencode/src/account/index.ts`
- `packages/opencode/src/auth/index.ts`
- `packages/opencode/src/cli/cmd/accounts.tsx`
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- `packages/opencode/src/cli/cmd/tui/component/dialog-account.tsx`
- `packages/opencode/src/server/routes/account.ts`
- `packages/opencode/test/provider/provider-cms.test.ts`

## Structured Execution Phases
- **Phase 1: Tier 1 - Storage Protection (Account Module)**
  Enhance `Account.add` to become a strict repository. It MUST throw an error if the target `accountId` already exists. Ensure `Account.remove` is a pure, synchronous deletion of local JSON state.
- **Phase 2: Tier 2 - Unified Identity Service (Auth/Service Module)**
  Refactor `Auth.set` (or a dedicated `AccountManager`) to handle collision resolution (suffixing `Date.now()`) *before* calling the strict `Account.add`. Enhance API key deduplication logic. Implement an async deletion method that performs the pure storage deletion and fires a non-blocking background promise for heavy cleanup (`Provider.dispose()`).
- **Phase 3: Tier 3 - Presentation Layer Strict Routing**
  Refactor all entry points (`accounts.tsx`, `dialog-admin.tsx`, `dialog-account.tsx`, etc.) to *strictly* use the Tier 2 Service Layer for additions and deletions, preventing them from directly accessing the Tier 1 Storage. Implement optimistic UI updates before awaiting Tier 2 deletion.
- **Phase 4: Validation**
  Run exhaustive tests to ensure no UI freezing on deletion, duplicate API keys added via CLI generate suffixed IDs, and direct `Account.add` calls with colliding IDs throw errors. Verify `bun turbo typecheck` and `bun test`.

## Validation
- Add an API key via CLI with the name "Default" twice. The `accounts.json` should have two separate entries with suffixed IDs, not an error.
- Call `Account.add('gemini-cli', 'existing-id', {...})` programmatically. It MUST throw an error.
- Delete an active account in the TUI. The list should update instantly, without blocking input.
- `bun test` and `bun turbo typecheck` pass.

## Handoff
- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.
