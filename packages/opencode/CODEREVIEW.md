# Code Review Report: opencode-cms

**Branch:** `cms` (compared to `dev`)
**Date:** 2026-01-31
**Reviewer:** Opencode Agent

## Summary

The `cms` branch introduces significant improvements to the TUI (Terminal User Interface), creates a centralized Account management system, implements a new global debugging facility, and fixes critical bugs in the Antigravity plugin.

## 1. Local Changes (`src/session/message-v2.ts`)

**Status:** ⚠️ Uncommitted changes detected.

- **Change:** Refactored `toModelOutput` to use `value` instead of `text` for string outputs and standardized attachment handling to return `{ type: "content", value: [...] }`.
- **Assessment:** These changes align with the latest AI SDK message format requirements mentioned in the changelog.
- **Action:** **Recommended to commit** these changes as they appear necessary for the "fix AI_InvalidPromptError" item.

## 2. Key Features & Fixes

### A. Centralized Account Management (`src/account/index.ts`)

- **Impact:** High. Replaces scattered authentication logic with a unified `Account` namespace.
- **Review:**
  - ✅ **Good:** Solves the identity resolution issue (converting UUIDs/IDs to Emails) using `getDisplayName`.
  - ✅ **Good:** Implements proper migration logic from legacy `auth.json` and plugin-specific files.
  - ⚠️ **Style:** Uses `let` statements in several places (e.g., `let email = ...`, `let _storage`).
    - _Suggestion:_ Refactor to `const` where possible using tertiary operators or helper functions (e.g., `iife`), aligning with the project's "No let" policy.
  - ℹ️ **Note:** Uses `require("../util/jwt")` lazily. This likely avoids a circular dependency cycle, which is acceptable in this context but worth noting.

### B. Antigravity Plugin Fixes (`src/plugin/antigravity/plugin/request.ts`)

- **Impact:** Critical. Fixes model communication issues.
- **Review:**
  - ✅ **Verified:** The critical fix for Gemini models is present:
    ```typescript
    if (isGeminiModel(effectiveModel)) {
      applyGeminiTransforms(requestPayload, { ... })
    }
    ```
  - This ensures request payloads are correctly formatted for the strict upstream API requirements.

### C. TUI Improvements (`src/cli/cmd/tui/component/dialog-model.tsx`)

- **Impact:** High. Improves user experience significantly.
- **Review:**
  - ✅ **Good:** Implements "Probe" logic (`probeAndSelectModel`) to prevent selecting broken models.
  - ✅ **Good:** Adds hierarchical navigation (Family -> Account -> Model).
  - ⚠️ **Complexity:** The `DialogModel` component is becoming monolithic (~800+ lines implied). It handles state, data fetching (`createResource`), filtering, probing, and rendering.
    - _Suggestion:_ For future refactoring, extract the probing logic and data aggregation into a custom hook (e.g., `useModelSelection`).

### D. Debug System (`src/util/debug.ts`)

- **Impact:** Medium. Facilitates better troubleshooting.
- **Review:**
  - ✅ **Clean:** Simple, effective implementation using `fs/promises`.
  - ✅ **Safe:** `debugSpan` correctly handles errors and re-throws them, ensuring transparency.

## 3. General Observations

- **Documentation:** The branch adds `CHANGELOG.md` and `DEBUGLOG.md`, which is excellent for tracking complex changes.
- **Dependencies:** New dependency logic in `Account` seems robust but relies on the file system structure remaining consistent.

## Recommendations

1.  **Commit Local Changes:** `git add src/session/message-v2.ts && git commit -m "refactor: update message format for SDK compliance"`
2.  **Merge Strategy:** The branch appears stable and addresses critical bugs. Safe to merge into `dev` after verifying the TUI performance on lower-end machines (due to the complex reactivity in `DialogModel`).
3.  **Refactor (Future):** Plan a refactor for `DialogModel` to reduce its cyclomatic complexity.

## 4. PLANNING Verification Checklist
Based on `packages/opencode/PLANNING.md` status:

- [x] **Scaffold**: Created `src/cli/cmd/admin.ts` and `dialog-admin.tsx`.
- [x] **Level 1 (Root)**: Implemented Root view with Favorites/Recents/Families.
- [x] **Level 2 (Accounts)**: Implemented Account Manager with:
    - [x] `Account.setActive` logic.
    - [x] Google-API auth transition fix (Switch/Match).
- [x] **Level 3 (Models)**: Implemented Model List navigation in `DialogModel`.
- [x] **Auth Unification**: `/admin` serves as the single entry point.
- [x] **Antigravity Rotation**: Implemented authoritative selection logic in `DialogModel`.
- [x] **Fast Fail on RL**: Implemented via Model Probe (`probeAndSelectModel`) and UI feedback.
- [x] **Wiring**: Command registered and navigation flow verified.
