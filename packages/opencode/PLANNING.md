# Admin Handler Refactoring Plan

The objective is to consolidate the `/model` and `/accounts` commands into a unified `/admin` handler with a hierarchical TUI structure, and make `/admin` the single source of truth for auth + primary model selection.

## Updated Requirements (2026-01-30)
- `/admin` is the **single centralized account manager** for **all providers**.
- `/admin` selects the **primary chat model** for the current conversation.
- Agents are free to pick any model from the **full logged-in pool**, regardless of family or account.
- Keep the **three-level navigation** (root → accounts → models).
- **No antigravity auto account rotation**. `/admin` selection is authoritative.
- On **rate limit**, fail fast so higher-level logic can **fallback to Favorites** (do not wait).
- Keep changes **modular and portable** for future `origin/dev` rebases.

## Command: `/admin`
New command entry point.

## Component Structure: `DialogAdmin`
A new TUI component managing 3 distinct hierarchical levels. Use `flux` pattern or simple signal state machine for navigation.

### Level 1: Root (Selection)
**Components:**
- Favorites (Folder)
- Recents (Folder)
- Provider Families (List: Antigravity, OpenAI, etc.)

**Logic:**
- **Recents/Favorites:** Selecting an item immediately calls `local.model.set()` and closes the dialog.
- **Provider Family:** Selecting an item sets internal state `currentFamily` and advances to Level 2.

### Level 2: Account Management
**Context:** Active `currentFamily`.
**Data Source:** `Account.list(currentFamily)` for core auth + provider-specific managers for specialized pools.

**Keybinds & Interactions:**
- **Main List:** Shows all accounts. Active account indicated (e.g., Green Dot).
- **`Space`**: Toggle **Active** status.
  - Action: Call `Account.setActive(currentFamily, accountId)`.
  - Effect: Updates UI immediately.
- **`Enter`**: Proceed to Models.
  - Action: If selection is different from active, auto-set active? Or just proceed using the *currently set* active account? (Likely: Set selection as active -> Proceed).
  - Transition: Advance to Level 3.
- **`a` / `n` (Add)**: Launch `DialogProvider` (Connection Wizard).
- **`d` / `Delete`**: Delete selected account.
- **`r` (Re-auth)**: Trigger re-authentication flow (usually "Add" flow pre-seeded or fresh).

### Level 3: Model Selection
**Context:** Models for `currentFamily` (using the Active Account set in Level 2).
**Data Source:** `sync.data.provider` (synced model list).

**Logic:**
- Display models available for the provider.
- **Keybinds:**
  - `h`: Toggle Hidden (Hide/Unhide).
  - `s`: Show All (Toggle visibility of hidden models).
  - `Enter`: Select model -> `local.model.set()` -> Close.

## Implementation Steps
1.  **Scaffold**: Create `src/cli/cmd/admin.ts` and `src/cli/cmd/tui/component/dialog-admin.tsx`. ✅
2.  **Level 1**: Implement Root view (migrate from `DialogModel` root). ✅
3.  **Level 2**: Implement Account Manager (migrate/adapt `DialogAccount` + `DialogModel` Tier 2 fixes). ✅
    - *Critical:* Ensure `Account.setActive` works reliably. ✅
    - *Fix:* Refactored `ApiMethod` to use Switch/Match for stable Google-API auth transitions. ✅
4.  **Level 3**: Implement Model List (migrate from `DialogModel`).
5.  **Auth Unification**: Make `/admin` the single entry for auth selection (all providers). ✅
6.  **Antigravity Rotation**: Add a fixed-account mode so `/admin` selection is authoritative.
7.  **Fast Fail on RL**: Avoid waiting on rate limit; let higher-level fallback handle model selection.
8.  **Wiring**: Register command, test navigation flow. ✅

## Open Questions
1.  **Legacy Commands:** Should `/model` and `/accounts` remain as shortcuts (aliased to specific levels of `/admin`), or be fully deprecated?
2.  **Active Switch Logic:** When pressing `Enter` on an inactive account in Level 2, should we implicitly switch to it before going to Level 3, or strictly require `Space` to switch first?
3.  **Re-auth UX:** For "Re-authentication", is delete-and-re-add sufficient, or is a specialized "Refresh" trigger needed?
4.  **Model Freshness:** Does switching the active account require a forced refresh of the model list (quota updates, beta models) before Level 3 appears?
