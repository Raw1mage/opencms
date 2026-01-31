# Changelog

## [1.1.60] - 2026-01-31

### Fixed
- **Antigravity Fallback**: Ensure Antigravity provider is always registered in the active provider list to prevent incorrect fallback to Codex when account sync is pending or incomplete.


## [1.1.57] - 2026-01-31

### Added
- **Debug System**: Implemented a centralized debug logging system in `src/util/debug.ts` with `debugCheckpoint` and `debugSpan` for granular tracing, integrated globally in `src/index.ts`.
- **Google-API Config Interface**: Completely refactored the Google-API authentication flow in `/admin` using a state-machine based `ApiMethod` component for reliable step-by-step configuration.
- **Admin CLI Command**: Registered `admin` as a top-level CLI command to allow direct access to the configuration interface.

### Fixed
- **DialogPrompt Input Stability**: Redesigned `DialogPrompt` to prevent accidental buffer clearing on Enter. It now captures text snapshots before any potential clearing and uses a multi-layered event interception strategy.
- **TUI Reactivity**: Replaced standard `<Show>` forks with explicit `<Switch>/<Match>` states in authentication flows to ensure clean UI transitions between prompt steps.
- **Focus Management**: Improved Tab key navigation between textareas and submit buttons in dialog prompts.

## [1.1.58] - 2026-01-31

### Added
- **Admin Debug Tracing**: Expanded debug logging with dialog stack tracing, error boundary reporting, and admin decision checkpoints stored in `~/opencode/logs/debug.log`.
- **Auto Admin Entry**: Added `OPENCODE_ADMIN_AUTO=1` to launch `/admin` directly when running `bun run dev`.

### Changed
- **Google-API Add Flow**: Moved the Google-API account editor to a dialog overlay to avoid admin state resets and ensure stable input/submit behavior.
- **Admin Root Providers**: Root provider list now includes core account families even when sync providers are empty.

### Fixed
- **Google-API Input Persistence**: Account name/API key values now persist on Enter before saving.
- **Admin Delete Behavior**: Deleting an account no longer forces a navigation back to root.
- **Model Selection Focus**: Closing dialogs now refocuses the main prompt input for keyboard-only usage.

## [1.1.59] - 2026-01-31

### Fixed
- **Rate limit reroute**: When a prompt hits a rate limit we now open `/admin` directly inside the failing provider's model list (keeping your draft prompt intact) so you can quickly pick another model without manually navigating back.

## [1.1.56] - 2026-01-31

### Added
- **Select dialog mouse UX**: Added `hoverSelect` property to control whether mouse hover triggers list item selection, preventing accidental jumps in long menus.
- **Improved navigation**: Added logic to lock back navigation during critical account selection steps in `/admin` to prevent accidental exits.
- **TUI select logic**: Selection lists now prioritize the current model or the first available option depending on the selection step.


## [1.1.55] - 2026-01-30

### Fixed
- **Prompt submit fallback**: Treat `linefeed` as submit and add a clickable submit control so single-line prompts (like Google-API account name) can advance even when Enter is mapped to linefeed.

## [1.1.54] - 2026-01-30

### Fixed
- **Prompt submit keys**: Account name prompts now respect the shared textarea keybindings and accept `enter`/`return`, so Google-API account setup can advance reliably.

## [1.1.53] - 2026-01-30

### Added
- **Google AI Studio sync**: `/admin` refreshes the Google Generative Language model list (using the active Google API key) when viewing the Google-API model picker so the options mirror the official AI Studio roster.

## [1.1.52] - 2026-01-30

### Fixed
- **Google API auth**: Skip the Antigravity OAuth method for `google` so the only auth path is the API key flow, preventing the incorrect “OAuth with Google (Antigravity)” option.
- **DialogPrompt submit**: Treat `enter` in addition to `return` so account-name prompts accept Enter and proceed to the next step.

## [1.1.51] - 2026-01-30

### Fixed
- **Favorites gutter**: Wrap the `⭐` glyph in `<text>` to prevent orphan text errors when `/admin` or `/model` lists favorite models.
- **Model cost badges**: Only render the "Free" footer when both the model's input and output costs are zero so subscription models stop showing the wrong "Free" label.

## [1.1.50] - 2026-01-30

### Fixed
- **Anthropic account visibility**: Do not hide `*-subscription-*` family suffix accounts when they are the only account in that family.
- **Account list clutter**: Removed inline "Add new account" action rows; use `A/a` hotkey instead.
- **Accidental dialog dismiss**: Clicking outside dialogs no longer closes them; use `esc`.
- **Account counts**: Show "1 account" for single-account providers.
- **Account focus**: Default account list selection now highlights the first account entry.
- **Account deletion UX**: Deleting an account no longer kicks the UI back to the root list.
- **Google API accounts**: Prompt for account name and ensure each API key creates a distinct account entry.
- **/admin model selection**: Resolve model lists when account IDs don't match provider IDs (fixes empty OpenCode/Anthropic model lists).
- **Keybind layout**: Show account/model hotkeys in a single inline row.

### Changed
- **Planning docs**: Deprecated root `PLANNING.md` in favor of `packages/opencode/PLANNING.md`.
- **Rate limit UX**: Auto-open `/admin` model selector when a session hits rate limits.
- **Provider label**: Rename Google provider label to "Google-API" in admin/model TUI.
- **Account hotkeys**: Show account management hotkeys in a single inline row.

## [1.1.49] - 2026-01-30

### Changed
- **Account selection UX**: Removed search input in account lists; added `A` hotkey for adding accounts directly within the current family.
- **Keybind layout**: Two-column keybind display for account/model views; Back hidden in model view.
- **Root list**: Favorites/Recents now expanded directly (no Quick Access folder) in both admin and model dialogs.

### Fixed
- **Account counts**: Provider account counts now match filtered core accounts (no Gemini CLI mismatch).
- **Account deletion**: Delete stays on the same account list and refreshes immediately.
- **Active indicators**: Removed account-level active dots to avoid multiple-green-dot confusion.

## [1.1.48] - 2026-01-30

### Fixed
- **Google API account list**: Dialog-model now uses core accounts (no phantom `google` entry) and deletes correct IDs.
- **Account delete flow**: Stays on account list after delete and refreshes state immediately.
- **Root quick access**: Quick Access folder replaced by expanded Favorites/Recents list in model selector.

## [1.1.47] - 2026-01-30

### Fixed
- **/admin active indicator**: Only the single active account shows a green dot for Antigravity.
- **/admin account counts**: Root provider counts now reflect core account storage, preventing phantom Gemini CLI accounts.
- **/admin account list**: Filters legacy generic IDs (e.g. `gemini-cli`, `gemini-cli-subscription-gemini-cli`) when specific accounts exist.

### Changed
- **Root list labels**: Standardized “Recents” category label to match UI copy.

## [1.1.46] - 2026-01-30

### Changed
- **Antigravity account rotation**: Added fixed-account mode so /admin selection is authoritative; auto rotation disabled by default.
- **Rate limit behavior**: Fail fast in fixed mode to allow higher-level model fallback instead of waiting or rotating accounts.

### Fixed
- **/admin account management**: Active selection now updates both core and antigravity manager, and refreshes the in-memory pool after set/delete.
- **Antigravity UI drift**: Global account manager refresh added to prevent stale account counts after deletion.

## [1.1.45] - 2026-01-30

### Fixed - Antigravity Model Communication (Critical) ✅ RESOLVED

**Problem**: Antigravity models were completely non-functional, showing "This version of Antigravity is no longer supported" errors and requests stuck in "Build" state.

**Root Causes**:
1. **Version Incompatibility** (`fingerprint.ts:22`): Code randomly selected from 6 versions (1.14.0-1.15.8), but Antigravity server only accepts 1.15.8 since 2026-01-24. This caused 83% failure rate.
2. **Missing Transform Logic** (`request.ts:824-832`): `applyGeminiTransforms` function existed but was never called, causing request format mismatches.
3. **Hardcoded Debug Logs** (`index.ts:1364-1370`): Console.log statements always printed debug info regardless of configuration.

**Critical Fixes**:
- **Version Fix**: Updated `ANTIGRAVITY_VERSIONS` array to only include `["1.15.8"]`
- **Account Data Fix**: Updated stored account data to use version 1.15.8
- **Transform Implementation**: Added `isGeminiModel()` check and proper `applyGeminiTransforms()` call with all required options
- **Claude Transform**: Unified Claude transformation logic using `applyClaudeTransforms()`
- **Debug Cleanup**: Removed hardcoded console.log statements

**Verification** (All Completed ✅):
- ✅ All 129 Gemini transform tests pass
- ✅ TypeScript compilation successful
- ✅ Version warnings eliminated
- ✅ Models respond normally to messages (tested with Claude Opus 4.5 Thinking)
- ✅ Cache cleared and server restarted
- ✅ Multiple successful conversations confirmed

**Reference**: GitHub Issue [#324](https://github.com/NoeFabris/opencode-antigravity-auth/issues/324)

**Key Insight**: This bug was difficult to diagnose because:
- Random version selection masked the problem (intermittent failures)
- Multiple failure points (version + transform) created compound issues
- Error messages were misleading (focused on version, not request format)
- Full server restart was required for all fixes to take effect

### Added
- **Unified Models Command**: Refactored `/models` to serve as the central status dashboard. Now displays a 3-tier hierarchy (Provider -> Account -> Model) with integrated health status (Rate Limit/Cooldown) for each model.
- **Removed Legacy Commands**: Removed `/dashboard` and `/model-check` in favor of the new, comprehensive `/models` view.
- **Antigravity & Gemini-CLI Separation**: strict separation of model lists and statuses for Antigravity and Gemini-CLI providers.


## [1.1.44] - 2026-01-30



### Fixed
- **Antigravity Chat**: Fixed `TypeError [ERR_INVALID_URL]` by handling relative URLs (e.g., `v1beta/models/...`) in the Antigravity fetch wrapper.
- **Model List**: Resolved model count discrepancy by strictly filtering Antigravity models (blocking legacy/experimental artifacts) and prioritizing account emails in TUI display.
- **Accounts**:
    - Fixed "Time Travel" / crash issue caused by a corrupted `accounts.json` (trailing comma).
    - Hard-removed ghost account `gemini-cli-subscription-gemini-cli`.
    - Re-enabled Anthropic models by removing them from the ignored list and adding fallback population.
- **TUI Navigation**:
    - Mapped `Left Arrow` key to "Back" (exit/clear) in `/models`, `/accounts`, and `/connect` menus.
    - Mapped `a` key in `/models` to open `/accounts` (Accounts TUI) instead of `/connect`.

## [1.1.43] - 2026-01-30

- Implemented strict account isolation for Google login types:
    - `antigravity` provider now uses `antigravity-accounts.json`.
    - `gemini-cli` provider now uses `gemini-cli-accounts.json`.
    - This ensures accounts are correctly separated and never mixed between providers.
- Refactored `AccountManager` to support parameterized storage files.
- Removed `account-check` command and associated tools.

## [0.0.0-cms-202601291945] - 2026-01-29

- Hide base Anthropic provider models in /models when an active Anthropic subscription account is present, preventing Claude Code-only credentials from being selected.

## [0.0.0-cms-202601291955] - 2026-01-29

- Fix Google API key accounts not injecting `apiKey` into provider options, preventing Gemini models from failing with missing key errors.

## [0.0.0-cms-202601292005] - 2026-01-29

- Globally filter out `gemini-embedding-001` across all provider variants to avoid listing non-chat embedding models.

## [0.0.0-cms-202601292015] - 2026-01-29

- Skip embedding models in /model-check so non-chat embeddings do not surface as health failures.

## [0.0.0-cms-202601300355] - 2026-01-30

- Lazy-load TUI commands in CLI and allow `OPENCODE_SKIP_TUI=1` so headless `model-check` can run without JSX runtime deps.

## [0.0.0-cms-202601291930] - 2026-01-29

- Restrict /models to show only the active subscription per provider family and label categories with the active owner id using accounts display-name logic.
- Hide unsupported Gemini embedding models from /models.

## [0.0.0-cms-202601291900] - 2026-01-29

- Fix Anthropic Claude Max OAuth flow by updating the built-in auth plugin and removing the incorrect OAuth block.
- Restore Anthropic provider UI copy to indicate Claude Max support alongside API keys.

## [0.0.0-cms-202601300230] - 2026-01-30

- Improved account management CLI:
    - Implemented JWT decoding for OpenAI and other subscription accounts to show real email addresses instead of UUIDs.
    - Added aggressive identifier discovery to prioritize human-readable names over generic IDs or UUIDs.
    - Implemented specific fallback mapping for Anthropic (`company@thesmart.cc`) and Opencode (`yeatsluo@gmail.com`) primary accounts.
    - Refactored removal hotkeys: switched from `backspace` to `x` and `delete` to prevent accidental deletions.
    - Simplified deletion confirmation dialog: any non-"Yes" input (including Escape or Cancel) now immediately cancels the action.
- Enhanced TUI stability:
    - Fixed a fatal crash (`undefined is not an object`) during TUI startup when agent or model data is not yet fully loaded.
    - Added optional chaining and safe fallbacks for agent name, color, and model accesses across prompt and agent dialog components.

## [0.0.0-cms-202601290930] - 2026-01-29

- Resiliency for sandboxed runs: `Global.Path` now validates that the configured XDG directories are writable, falls back to a local `.opencode-data` workspace root when they are not, and honors `OPENCODE_DATA_HOME` to pin the alternative location.

## [0.0.0-cms-202601290848] - 2026-01-29

- Fix `TypeError [ERR_INVALID_URL]` in Antigravity and Gemini-CLI plugins by properly handling relative API paths in the fetch interceptor.
- Implement a model ignore list to filter out unsupported, deprecated, or buggy models (e.g., direct Anthropic Claude 3.5 Sonnet that fails with Claude Code credentials).
- Improve Antigravity request robustness by ensuring all intercepted URLs are absolute before processing.
- Preserve Claude-specific headers (`User-Agent`, `anthropic-client`) during fingerprint application to prevent authentication failures.

## [0.0.0-cms-202601290822] - 2026-01-29

- Fix Anthropic authentication issue for "Claude Code" credentials by adding `User-Agent` and `anthropic-client` headers.
- Fix `AI_InvalidPromptError` by updating `toModelMessages` to comply with standard AI SDK part formats (using `text` instead of `value`) and improving tool output conversion.

## [0.0.0-cms-202601290808] - 2026-01-29

- Planning to migrate raw branch customizations into cms (latest dev).
- Allow antigravity/gemini-cli providers even when enabled_providers is set to google, restoring account model checks.
- Add CLI model-check command registration and resilient logging to make cms dev mode runnable again.
# Changelog

## [1.1.51] - 2026-01-30

### Fixed
- **Favorite indicators**: Wrap the `⭐` glyph in `<text>` so `/admin` and `/model` dialogs no longer emit orphan-text errors when showing favorite models.

## [1.1.50] - 2026-01-30

### Fixed
*snip existing*
