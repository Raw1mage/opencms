# Event: Account Manager Slice 0 Implementation

**Date**: 2026-03-19
**Spec**: `specs/20260318_webapp-provider-gemini-cli-api-key-account-name-account-name-ge/`
**Branch**: `account-manager-refactor` (opencode-beta repo)

## Scope

Tasks 0.1–0.8 from tasks.md (Slice 0 — AccountManager Service Layer + Event Bus foundation).

## Key Decisions

1. **Event naming**: Used dot notation (`account.connected`, `account.removed`, etc.) consistent with existing bus events (`pty.created`, `session.updated`).
2. **AccountManager.connectOAuth**: Wraps `Auth.set` rather than duplicating its dedup logic. Detects new vs updated account by snapshotting account list before/after `Auth.set`.
3. **mutate() pattern**: Introduced `mutate(callback)` in Account module — deep clones `_storage`, applies mutation to clone, saves clone to disk, then swaps `_storage` only on success. This prevents in-memory corruption on save failure.
4. **Write-ahead save()**: Changed from `Bun.write(filepath)` to `Bun.write(tmpPath) → fs.rename(tmpPath, filepath)` for atomic writes. Temp file cleaned up on failure.
5. **subscriptionProvidesAuth**: Added to `ProviderCapabilities` interface rather than creating a separate capability system. Only `gemini-cli` sets it to `false`.
6. **Auth.remove legacy fix**: Changed `resolveFamilyOrSelf` → `resolveProviderOrSelf` (both exist as aliases, but the canonical name is provider).
7. **Read-only delegations**: AccountManager exposes `list`, `listAll`, `get`, `getById`, `getActive`, `getActiveInfo` as pass-through to Account (no events needed for reads).

## Files Changed

### New
- `packages/opencode/src/account/manager.ts` — AccountManager service + AccountEvent definitions

### Modified
- `packages/opencode/src/account/index.ts` — write-ahead `save()`, `mutate()` helper, refactored `add/update/remove/setActive/deduplicateByToken/repairEmails` to use `mutate()`
- `packages/opencode/src/provider/capabilities.ts` — added `subscriptionProvidesAuth` field to `ProviderCapabilities`, added `subscriptionProvidesAuth()` convenience function
- `packages/opencode/src/auth/index.ts` — replaced gemini-cli hardcode with capability lookup, fixed `resolveFamilyOrSelf` → `resolveProviderOrSelf`

## Verification

- **TypeScript**: `tsc --noEmit` passes cleanly (no errors in project code)
- **Runtime import**: `AccountManager` and `AccountEvent` export correctly with all expected methods/events
- **Events**: 5 event types registered: Connected, Removed, Renamed, ActiveChanged, Updated
- **Manager methods**: 12 methods exported: connectApiKey, connectOAuth, removeAccount, renameAccount, setActiveAccount, updateAccount, list, listAll, get, getById, getActive, getActiveInfo

## Remaining (Slice 0)

- [ ] 0.9 TUI consumer: subscribe to account events in session init
- [ ] 0.10 Web SSE consumer: add account event channel to SSE endpoint
- [ ] 0.11 End-to-end validation: mutation → event → consumer sync

## Architecture Sync

Architecture changes introduced:
- New `AccountManager` service layer as single mutation entry point
- Event bus now has account event types (was previously zero)
- Write-ahead storage pattern for accounts.json

These will be synced to `specs/architecture.md` when Slice 0 is fully complete (including consumers 0.9–0.11).
