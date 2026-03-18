# Tasks

## 1. Phase 1: Tier 1 - Storage Protection (Account Module)
- [ ] 1.1 In `packages/opencode/src/account/index.ts`, modify `Account.add` (and related methods like `Account.update` if necessary) to strictly THROW an error if an `accountId` already exists instead of silently overwriting.
- [ ] 1.2 In `packages/opencode/src/account/index.ts`, review `Account.remove` and ensure it is a pure, synchronous deletion of the local JSON state without performing heavy asynchronous cleanups (like Provider disposal) that block the event loop.

## 2. Phase 2: Tier 2 - Unified Identity Service (Auth/Service Module)
- [ ] 2.1 Refactor `packages/opencode/src/auth/index.ts` (`Auth.set` or equivalent) to be the strict centralized Unified Identity Service. Move the collision generation logic (suffixing IDs) from `Account.add` (from the previous patch) into this service layer.
- [ ] 2.2 Enhance the API key deduplication logic in the Service layer to check if the same key already exists under a different name, handling it gracefully.
- [ ] 2.3 Implement an asynchronous account removal method in the Service layer (`Auth.remove` or a new `AccountManager.removeAccount`) that orchestrates the pure storage deletion (`Account.remove`) and then fires a non-blocking background promise for heavy cleanup (`Provider.dispose()`, `save(storage)`).

## 3. Phase 3: Tier 3 - Presentation Layer Strict Routing
- [ ] 3.1 Refactor `packages/opencode/src/cli/cmd/accounts.tsx` to strictly call the Tier 2 Service Layer for additions and deletions, preventing it from directly accessing the Tier 1 Storage (`Account.add`).
- [ ] 3.2 Refactor `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` to strictly use the Tier 2 Service Layer for additions and deletions.
- [ ] 3.3 Refactor `packages/opencode/src/cli/cmd/tui/component/dialog-account.tsx` to use optimistic UI updates immediately before awaiting the Tier 2 Service Layer deletion, preventing UI freezes.
- [ ] 3.4 Ensure `packages/app/src/components/settings-accounts.tsx` optimally uses the non-blocking Tier 2 Service Layer endpoints.

## 4. Phase 4: Validation
- [ ] 4.1 Test adding duplicate named API keys via CLI and Admin Panel. They should succeed by generating suffixed IDs via the Service Layer.
- [ ] 4.2 Test deleting an active account in TUI and verify no screen freezing occurs.
- [ ] 4.3 Test manually calling `Account.add` directly with an existing ID via a script or repl to verify it throws an error.
- [ ] 4.4 Run `bun test` and ensure all tests pass (including `provider-cms.test.ts`).
- [ ] 4.5 Ensure `bun turbo typecheck` passes cleanly across the monorepo.
