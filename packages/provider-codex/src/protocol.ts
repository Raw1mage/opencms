/**
 * Codex protocol constants.
 *
 * Source: refs/codex/codex-rs/login/src/auth/default_client.rs
 *         refs/codex/codex-rs/core/src/client.rs
 */

/** OAuth client ID for Codex CLI */
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

/** OpenAI auth issuer */
export const ISSUER = "https://auth.openai.com"

/** Codex Responses API endpoint (backend-api, not api.openai.com) */
export const CODEX_API_URL = "https://chatgpt.com/backend-api/codex/responses"

/** WebSocket variant of the endpoint */
export const CODEX_WS_URL = "wss://chatgpt.com/backend-api/codex/responses"

/**
 * Originator header value. Must match the UA prefix sent in codex-auth.ts so
 * OpenAI's first-party classifier doesn't flag the request as third-party.
 * `codex_cli_rs` is the upstream DEFAULT_ORIGINATOR.
 * See: refs/codex/codex-rs/login/src/auth/default_client.rs
 */
export const ORIGINATOR = "codex_cli_rs"

/** Pinned codex-cli version we impersonate. Aligned with refs/codex tag. */
export const CODEX_CLI_VERSION = "0.125.0-alpha.1"

/** Beta features header for WebSocket v2 protocol */
export const WS_BETA_HEADER = "responses_websockets=2026-02-06"

/** OAuth port for local callback server */
export const OAUTH_PORT = 1455

/** Safety margin for device code polling */
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

/** Transport timeouts */
export const WS_CONNECT_TIMEOUT_MS = 15_000
export const WS_IDLE_TIMEOUT_MS = 30_000
export const WS_FIRST_FRAME_TIMEOUT_MS = 10_000
