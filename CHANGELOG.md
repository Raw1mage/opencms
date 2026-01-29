# Changelog

## [0.0.0-cms-202601291945] - 2026-01-29

- Hide base Anthropic provider models in /models when an active Anthropic subscription account is present, preventing Claude Code-only credentials from being selected.

## [0.0.0-cms-202601291955] - 2026-01-29

- Fix Google API key accounts not injecting `apiKey` into provider options, preventing Gemini models from failing with missing key errors.

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
