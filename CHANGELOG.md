# CHANGELOG

## Unreleased
- Planning to migrate raw branch customizations into cms (latest dev).
- Allow antigravity/gemini-cli providers even when enabled_providers is set to google, restoring account model checks.
- Add CLI model-check command registration and resilient logging to make cms dev mode runnable again.
- Fix `AI_InvalidPromptError` by updating `toModelMessages` to comply with standard AI SDK part formats (using `text` instead of `value`) and improving tool output conversion.
