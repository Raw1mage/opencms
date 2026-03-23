# Proposal

## Why
Currently, account addition and deletion lack a unified framework:
1. Webapp/TUI uses `Auth.set`, while CLI and Admin tools bypass it and call the low-level `Account.add` directly, missing deduplication checks.
2. Deduplication is inconsistent: OAuth checks `refreshToken`, API keys just check if the ID collides (and adds a suffix).
3. Deleting an account in TUI freezes the interface because `Account.remove` executes synchronously without optimistic UI or background disposal handling.
4. The underlying `Account` module acts as both a storage repository and an implicit business logic handler, violating separation of concerns.

## Original Requirement Wording (Baseline)
- "檢查一下新增帳號的程式框架有沒有統一框架。分析一下是否有太多局部patch而影響了整體功能的一致性"
- "規劃一個重構帳號新增刪除的管理框架，解決上述問題。希望能一體適用webapp和tui，並解決刪除帳號的指令按下後，會畫面停頓延遲的問題"
- "你有建議更好的全域統一框架嗎？還是單純patch已知bug"

## Requirement Revision History
- 2026-03-18: Initial plan proposed a system-wide patch (moving collision logic to `Account.add`).
- 2026-03-18: Revised to a true "Global Unified Framework" (3-Tier Architecture) per user feedback to eliminate leaky abstractions.

## Effective Requirement Description
1. Establish a strict 3-Tier Architecture for account management.
2. Tier 1 (Storage): `Account` module must be a pure repository that throws on ID collisions.
3. Tier 2 (Unified Identity Service): A new/upgraded service layer that handles identity deduplication, collision resolution, and async lifecycle cleanup.
4. Tier 3 (Presentation): All UI/CLI clients must strictly use Tier 2 and never call Tier 1 directly.

## Scope
### IN
- Refactoring `Account.add` and `Account.remove` to be strict, synchronous storage operations.
- Creating/Upgrading the Unified Identity Service (e.g., in `src/auth/index.ts` or a new `AccountManager`).
- Implementing identity deduplication for both OAuth and API accounts.
- Implementing asynchronous, non-blocking account deletion and provider disposal.
- Updating all call sites (CLI, TUI, Webapp, Admin) to use the new service layer.

### OUT
- Changes to the underlying `accounts.json` file schema (backward compatibility must be maintained).
- Adding new authentication methods or providers.
- Refactoring the internal execution logic of `Provider` instances beyond their disposal lifecycle.

## Non-Goals
- We are not rewriting the entire system's UI; we are only changing how the UI calls account management functions.

## Constraints
- The UI must remain responsive during account deletion (no freezing).
- Existing accounts in `accounts.json` must remain valid and loadable.

## What Changes
- The `Account` module becomes "dumb" storage.
- The `Auth` (or new `AccountManager`) module becomes the "smart" unified entry point.
- CLI (`accounts.tsx`) and Admin TUI (`dialog-admin.tsx`) are re-routed to use the smart layer.

## Capabilities
### New Capabilities
- **Strict Storage Protection**: The database layer actively rejects duplicate IDs instead of silently overwriting them.
- **Async Account Deletion**: The UI immediately reflects deletion, and backend state/processes dispose in the background without blocking the render loop.
### Modified Capabilities
- **Account Addition**: All interfaces (CLI, TUI, Webapp, Admin) now share the exact same identity deduplication and collision resolution logic.

## Impact
- Affects `packages/opencode/src/account`, `packages/opencode/src/auth`, TUI dialogs (`dialog-account.tsx`, `dialog-admin.tsx`), CLI tools (`accounts.tsx`), and Webapp endpoint (`server/routes/account.ts`).
