# 2026-04-17 — Config Crash Defense (Phase 1 of Config Restructure)

## Incident

- `~/.config/opencode/opencode.json` had `script` (6 bytes) accidentally appended to its tail.
- JSONC parsing failed; daemon could not serve `/global/config`.
- Webapp received a 500 response whose body contained the full 10 878-byte raw config text (OAuth tokens, API keys, etc.).
- The raw body was rendered as plain text in a toast notification, exposing secrets on-screen.

## Root Cause (three compounding layers)

1. [packages/opencode/src/config/config.ts](../../packages/opencode/src/config/config.ts) — `JsonError.message` was built as `"--- JSONC Input ---\n${text}\n--- Errors ---\n..."`, embedding the entire source into the thrown error.
2. [packages/opencode/src/server/app.ts](../../packages/opencode/src/server/app.ts) — `onError` returned `err.toObject()` at HTTP 500 unfiltered, so the raw message propagated into the API response body.
3. [packages/app/src/utils/server-errors.ts](../../packages/app/src/utils/server-errors.ts) — `formatServerError` fell through to `error.message` / raw string for unknown error shapes; toast rendered it as-is.

No fallback existed for parse failure either: the whole daemon was effectively blocked until the operator manually fixed the file.

## Phase 1 Fix

Landed on `beta/config-restructure`. Validation: 62 opencode tests + 9 webapp tests passing.

### config.ts

- `JsonError` schema expanded to structured fields: `path`, `message` (short summary only), `line`, `column`, `code`, `problemLine` (<=200 chars), `hint`.
- Introduced `buildJsoncParsePayload(text, filepath, errors)` that produces the structured payload and a daemon-side `debugSnippet` (±3 lines context). The snippet goes to `log.error`, never into the thrown error.
- Both parse sites (`load()` and `parseConfig()`) now use the helper.
- Added `config-lkg.json` last-known-good snapshot at `$XDG_STATE_HOME/opencode/config-lkg.json` (defaults to `~/.local/state/opencode/config-lkg.json`). Atomic write (`.pid.tmp` + rename) on every successful `createState()`.
- New `createState` wraps the previous implementation (now `createStateInner`): on `JsonError` / `InvalidError` / `ConfigDirectoryTypoError`, it reads the LKG snapshot and serves it with a `configStale: true` flag plus `log.warn` identifying the failed path, line, hint, and snapshot age. AGENTS.md rule #1 compliant (no silent fallback).
- If no LKG snapshot exists the error propagates unchanged — there is no "pretend it's fine" path.

### server/app.ts

- `onError` now maps `Config.JsonError`, `Config.InvalidError`, and `Config.ConfigDirectoryTypoError` to HTTP **503** (service temporarily unavailable) instead of 500.
- Response body remains `err.toObject()` but the payload is now structured and no longer carries raw config text.

### webapp

- [packages/app/src/utils/server-errors.ts](../../packages/app/src/utils/server-errors.ts) — added `ConfigJsonError` type + `isConfigJsonErrorLike` + `formatReadableConfigJsonError`, matching the existing `ConfigInvalidError` pattern. `formatServerError` now routes `ConfigJsonError` first.
- Added a defensive `truncate()` guard (500-char cap + `[truncated]` marker) for `Error.message` / raw string fall-through paths so older daemons or unexpected error shapes can never paint multi-KB blobs onto the toast again.

## Tests

New tests in `packages/opencode/test/config/config.test.ts`:

- "JsonError payload is structured and does not dump the full config file" — asserts `toObject()` size < 1 KB and excludes content from unrelated lines.
- "LKG snapshot lets Config.get() survive a corrupted opencode.json" — primes a valid config, waits for the fire-and-forget snapshot write, corrupts the file, confirms the next `Config.get()` returns the snapshotted value.
- Updated "validates config schema and throws on invalid fields" and "throws error for invalid JSON" to clear the LKG snapshot first (otherwise they would correctly use the snapshot from an earlier passing test and no longer throw).

New tests in `packages/app/src/utils/server-errors.test.ts`:

- `ConfigJsonError` formatting includes file, line/column, hint, and the single-line problem excerpt.
- String-fallback guard truncates any multi-KB raw payload to <600 chars.

## Follow-ups (Phase 2 / Phase 3)

Tracked under [plans/config-restructure/](../../plans/config-restructure/):

- Phase 2 — derive provider availability from `accounts.json`; drop the 109-entry `disabled_providers` denylist.
- Phase 3 — split `opencode.json` into `providers.json` and `mcp.json` with section-level error isolation; `templates/**` sync; migration scripts.

## Cross References

- Plan package: [plans/config-restructure/](../../plans/config-restructure/) (implementation-spec, spec, design, tasks, handoff, idef0, grafcet, c4, sequence)
- MCP lifecycle verification (lazy-connect confirmed) is captured in `implementation-spec.md` Assumptions; no MCP preflight required for Phase 3.
- Beta worktree: `/home/pkcs12/projects/opencode-beta` on branch `beta/config-restructure` — disposable per AGENTS.md, to be deleted after fetch-back + merge + cleanup.
