---
date: 2026-06-24
status: done
tags: [provider-codex, fingerprint, user-agent, version-bump]
summary: "Bump impersonated codex-cli version 0.125.0-alpha.1 → 0.142.0 (official stable)"
---

# Bump impersonated codex-cli version → 0.142.0

## Trigger

`@openai/codex` npm `latest` is **0.142.0** (alpha tag is 0.143.0-alpha.9). The
provider impersonated `0.125.0-alpha.1` (an alpha) — bumped to the official
stable. Refreshed `refs/codex` to upstream main (`8d80b0176`, 2026-06-23) first.

## What changed (code)

- `packages/provider-codex/src/protocol.ts`: `CODEX_CLI_VERSION 0.125.0-alpha.1
  → 0.142.0`. Single source of truth; consumed by
  `packages/opencode/src/plugin/codex-auth.ts` to build the UA
  `codex_cli_rs/{version} ({OS} {release}; {arch}) terminal`, matching upstream
  `get_codex_user_agent()` in `codex-rs/login/src/auth/default_client.rs`.
- `src/transport-ws.test.ts`: two UA fixture strings updated to 0.142.0
  (input/prefix fixtures, not version assertions).

## Verified unchanged against refreshed refs/codex (536 commits newer)

Read directly from source — no drift:

- `DEFAULT_ORIGINATOR = "codex_cli_rs"` (`login/src/auth/default_client.rs:41`)
- `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"` (`login/src/auth/manager.rs:1384`)
- `DEFAULT_ISSUER = "https://auth.openai.com"` (`login/src/server.rs:53`)
- `RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE = "responses_websockets=2026-02-06"`
  (`core/src/client.rs:147`)
- responses endpoint `https://chatgpt.com/backend-api/codex/responses`
- OAuth callback port 1455
- UA format string (`{originator}/{version} ({os} {ver}; {arch}) {ua}`)

Note: workspace `Cargo.toml` version is a `0.0.0` placeholder (version injected at
build via `CARGO_PKG_VERSION`), so the **npm release tag is the version source of
truth**, not the source tree. `user_agent()` moved to
`codex-rs/terminal-detection/src/lib.rs`; provider keeps the hardcoded `terminal`
tail (pre-existing simplification, orthogonal to the version).

## Verification

- `bun test src/transport-ws.test.ts`: **27 pass / 0 fail**.
- Full `bun test`: 139 pass / **3 fail** — all 3 pre-existing and unrelated
  (confirmed identical with the edit stashed): two INV-13 schema-drift guards
  ENOENT on a missing `specs/codex-empty-turn-recovery/data-schema.json`, and a
  `convertTools` golden-format test. Neither references the version or UA.

## Cross-refs

- `refs/codex/codex-rs/login/src/auth/default_client.rs` (UA/originator)
- `packages/opencode/src/plugin/codex-auth.ts` (UA builder)
