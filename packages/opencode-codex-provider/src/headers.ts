/**
 * Codex request header builder.
 *
 * Constructs the complete header set for Codex API requests,
 * including identity, auth, and context-window lineage headers.
 */
import { ORIGINATOR, WS_BETA_HEADER } from "./protocol.js"
import type { WindowState } from "./types.js"

export interface BuildHeadersOptions {
  accessToken: string
  accountId?: string
  /** Sticky routing token from previous response */
  turnState?: string
  /** Context-window lineage */
  window?: WindowState
  /** Parent thread id when this request is part of a subagent session */
  parentThreadId?: string
  /** Subagent lineage label (agent name) when this session is a subagent */
  subagentLabel?: string
  /** Installation UUID for analytics */
  installationId?: string
  /** Session ID for correlation */
  sessionId?: string
  /** User-Agent string */
  userAgent?: string
  /** Whether this is a WebSocket upgrade request */
  isWebSocket?: boolean
  /** Conversation id used as x-client-request-id (upstream codex-rs behavior) */
  conversationId?: string
}

export function buildHeaders(options: BuildHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "authorization": `Bearer ${options.accessToken}`,
    "originator": ORIGINATOR,
  }

  // HTTP path carries a JSON body; WS upgrade doesn't (first WS frame is JSON
  // but that's body, not header). Accept is set only on HTTP SSE to mirror
  // upstream .header("accept", "text/event-stream"); WS upgrade Accept is
  // governed by the WS library.
  if (!options.isWebSocket) {
    headers["content-type"] = "application/json"
    headers["Accept"] = "text/event-stream"
  }

  if (options.accountId) {
    headers["ChatGPT-Account-Id"] = options.accountId
  }

  if (options.turnState) {
    headers["x-codex-turn-state"] = options.turnState
  }

  if (options.conversationId) {
    headers["x-client-request-id"] = options.conversationId
  }

  // Context-window lineage (§6 of whitepaper; upstream codex-rs 9e19004bc2).
  // window-id is always emitted so the server can key its cache even for
  // top-level sessions. parent-thread-id + subagent are emitted only when
  // applicable — empty sentinels still travel but we pick the richest hint.
  if (options.window) {
    headers["x-codex-window-id"] = `${options.window.conversationId}:${options.window.generation}`
  }

  if (options.parentThreadId) {
    headers["x-codex-parent-thread-id"] = options.parentThreadId
  }

  if (options.subagentLabel) {
    headers["x-openai-subagent"] = options.subagentLabel
  }

  if (options.sessionId) {
    headers["session_id"] = options.sessionId
  }

  if (options.userAgent) {
    headers["User-Agent"] = options.userAgent
  }

  if (options.isWebSocket) {
    headers["OpenAI-Beta"] = WS_BETA_HEADER
  }

  return headers
}

/**
 * Build client_metadata for the request body.
 * Includes installation_id and window lineage.
 */
export function buildClientMetadata(options: {
  installationId?: string
  window?: WindowState
}): Record<string, string> | undefined {
  const metadata: Record<string, string> = {}
  let hasEntries = false

  if (options.installationId) {
    metadata["x-codex-installation-id"] = options.installationId
    hasEntries = true
  }

  if (options.window) {
    metadata["x-codex-window-id"] = `${options.window.conversationId}:${options.window.generation}`
    hasEntries = true
  }

  return hasEntries ? metadata : undefined
}
