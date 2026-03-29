/**
 * codex-compaction.ts — Server-side compaction via Codex Responses API
 *
 * Two compaction modes per OpenAI public API:
 *
 * 1. Inline (context_management): add compact_threshold to regular /responses
 *    calls; server auto-compacts when token count crosses threshold. The
 *    compaction item appears in response output and must be kept for next turn.
 *
 * 2. Standalone (/responses/compact): POST full context window to a dedicated
 *    endpoint; receive compacted output to replace conversation history.
 *    Request body mirrors codex-rs CompactionInput:
 *      { model, input, instructions, tools, parallel_tool_calls }
 *    Response body: { output: ResponseItem[] }
 *
 * Both modes return opaque compaction items that are not human-interpretable.
 * The caller must NOT prune /responses/compact output — it is the canonical
 * next context window.
 */

import { Auth } from "../auth"
import { Log } from "../util/log"

const log = Log.create({ service: "codex-compaction" })

const CODEX_COMPACT_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses/compact"
const COMPACT_TIMEOUT_MS = 60000

// ---------------------------------------------------------------------------
// Standalone compaction: POST /responses/compact
// ---------------------------------------------------------------------------

/**
 * Request body for /responses/compact.
 * Matches codex-rs CompactionInput struct.
 */
export interface CompactRequest {
  model: string
  input: unknown[]
  instructions: string
  tools: unknown[]
  parallel_tool_calls: boolean
}

export interface CompactResult {
  success: boolean
  /** Compacted output items — the canonical next context window */
  output?: unknown[]
}

/**
 * Call the standalone /responses/compact endpoint.
 * The returned output array is opaque and must not be pruned.
 */
export async function codexServerCompact(request: CompactRequest): Promise<CompactResult> {
  try {
    const liveAuth = await Auth.get("codex")
    const accessToken = (liveAuth as any)?.access
    const accountId = (liveAuth as any)?.accountId

    if (!accessToken) {
      log.warn("codex compact: no auth token")
      return { success: false }
    }

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=v1",
    }
    if (accountId) headers["chatgpt-account-id"] = accountId

    const body = JSON.stringify({
      model: request.model,
      input: request.input,
      instructions: request.instructions,
      tools: request.tools,
      parallel_tool_calls: request.parallel_tool_calls,
    })

    log.info("codex compact request", {
      model: request.model,
      inputItems: request.input.length,
      toolCount: request.tools.length,
      bodyBytes: body.length,
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), COMPACT_TIMEOUT_MS)

    const response = await fetch(CODEX_COMPACT_ENDPOINT, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      log.warn("codex compact failed", {
        status: response.status,
        statusText: response.statusText,
      })
      return { success: false }
    }

    const result = await response.json() as any

    // Response: { output: ResponseItem[] }
    const output = result.output
    if (!output || !Array.isArray(output)) {
      log.warn("codex compact: unexpected response shape", { keys: Object.keys(result) })
      return { success: false }
    }

    log.info("codex compact success", {
      inputItemsBefore: request.input.length,
      outputItems: output.length,
    })

    return { success: true, output }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      log.warn("codex compact timeout")
    } else {
      log.warn("codex compact error", { error: String(err) })
    }
    return { success: false }
  }
}

// ---------------------------------------------------------------------------
// Inline compaction: context_management parameter
// ---------------------------------------------------------------------------

/**
 * Build the context_management parameter for inline compaction.
 * Add this to the Responses API request body when you want the server to
 * auto-compact when the rendered token count crosses compact_threshold.
 *
 * The compaction item will appear in response.output and must be preserved
 * in conversation history for the next turn.
 */
export function buildContextManagement(compactThreshold: number): unknown[] {
  return [{ type: "compaction", compact_threshold: compactThreshold }]
}
