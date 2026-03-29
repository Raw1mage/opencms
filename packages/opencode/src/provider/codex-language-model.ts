/**
 * codex-language-model.ts — LanguageModelV2 backed by native C transport (stdio)
 *
 * Architecture:
 *   Bun.spawn("codex-provider") → stdin: request JSON → stdout: JSONL events
 *
 * The C process handles 100% of the wire protocol:
 *   - Request body construction (exact codex-rs format)
 *   - All 14 HTTP header types
 *   - HTTP POST via libcurl
 *   - SSE event parsing (9 event types)
 *   - Error mapping
 *
 * Auth comes from opencode's existing auth system (codex.ts plugin).
 * Tokens are passed to the C process via stdin JSON.
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2CallWarning,
  LanguageModelV2FinishReason,
  LanguageModelV2Usage,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider"
import { Log } from "../util/log"
import { CodexWebSocket, type CodexWsRequest } from "./codex-websocket"
import path from "path"
import fs from "fs"

const log = Log.create({ service: "codex-language-model" })

// --------------------------------------------------------------------------
// Find the codex-provider binary
// --------------------------------------------------------------------------

const BINARY_NAMES = ["codex-provider"]

const SEARCH_PATHS = [
  path.join(import.meta.dir, "../../../opencode-codex-provider/build"),
  "/usr/local/bin",
  "/usr/bin",
  path.join(process.env.HOME ?? "", ".local/bin"),
]

function findBinary(): string | null {
  for (const dir of SEARCH_PATHS) {
    for (const name of BINARY_NAMES) {
      const p = path.join(dir, name)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

let cachedBinaryPath: string | null | undefined

function getBinaryPath(): string | null {
  if (cachedBinaryPath !== undefined) return cachedBinaryPath
  cachedBinaryPath = findBinary()
  if (cachedBinaryPath) {
    log.info("found codex-provider binary", { path: cachedBinaryPath })
  } else {
    log.warn("codex-provider binary not found", { searchPaths: SEARCH_PATHS })
  }
  return cachedBinaryPath
}

// --------------------------------------------------------------------------
// Convert AI SDK prompt → Responses API format for C process stdin
// --------------------------------------------------------------------------

function promptToRequestBody(
  modelId: string,
  options: LanguageModelV2CallOptions,
  auth: { accessToken?: string; accountId?: string },
  extra?: { conversationId?: string; turnState?: string; betaFeatures?: string; promptCacheKey?: string; compactThreshold?: number; compactedOutput?: unknown[] },
): Record<string, unknown> {
  let instructions = ""
  const input: unknown[] = []

  // If compacted output exists, use it as the input prefix.
  // Per API spec: "Do not prune /responses/compact output. The returned
  // window is the canonical next context window."
  // We still extract instructions from system messages, but the compacted
  // items replace all prior conversation history. Only the last user
  // message (the new turn) is appended after the compacted items.
  if (extra?.compactedOutput?.length) {
    input.push(...extra.compactedOutput)
    // Extract instructions from system messages, append only the last user message
    for (const msg of options.prompt) {
      if (msg.role === "system") {
        if (instructions) instructions += "\n"
        instructions += msg.content
      }
    }
    // Find the last user message and append it (the new input after compaction)
    for (let i = options.prompt.length - 1; i >= 0; i--) {
      const msg = options.prompt[i]
      if (msg.role === "user") {
        const contentItems: unknown[] = []
        for (const part of msg.content) {
          if (part.type === "text") {
            contentItems.push({ type: "input_text", text: part.text })
          }
        }
        if (contentItems.length > 0) {
          input.push({ type: "message", role: "user", content: contentItems })
        }
        break
      }
    }
  } else {

  for (const msg of options.prompt) {
    if (msg.role === "system") {
      if (instructions) instructions += "\n"
      instructions += msg.content
      continue
    }

    if (msg.role === "user") {
      const contentItems: unknown[] = []
      for (const part of msg.content) {
        if (part.type === "text") {
          contentItems.push({ type: "input_text", text: part.text })
        } else if (part.type === "file" && part.mediaType?.startsWith("image/")) {
          const data = typeof part.data === "string" ? part.data : undefined
          if (data) {
            // Responses API requires a valid URL for image_url.
            // base64 data must be wrapped as data: URL.
            const imageUrl = data.startsWith("http") || data.startsWith("data:")
              ? data
              : `data:${part.mediaType};base64,${data}`
            contentItems.push({ type: "input_image", image_url: imageUrl })
          }
        }
      }
      input.push({ type: "message", role: "user", content: contentItems })
      continue
    }

    if (msg.role === "assistant") {
      const contentItems: unknown[] = []
      for (const part of msg.content) {
        if (part.type === "text") {
          contentItems.push({ type: "output_text", text: part.text })
        } else if (part.type === "reasoning") {
          // Preserve encrypted_content for server-side reasoning reuse
          const enc = (part as any).providerMetadata?.openai?.reasoningEncryptedContent
            ?? (part as any).providerOptions?.openai?.reasoningEncryptedContent
          input.push({
            type: "reasoning",
            summary: [{ type: "summary_text", text: part.text }],
            ...(enc ? { encrypted_content: enc } : {}),
          })
        } else if (part.type === "tool-call") {
          input.push({
            type: "function_call",
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
          })
        }
      }
      if (contentItems.length > 0) {
        input.push({ type: "message", role: "assistant", content: contentItems })
      }
      continue
    }

    if (msg.role === "tool") {
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          input.push({
            type: "function_call_output",
            call_id: part.toolCallId,
            output: typeof part.output === "string" ? part.output : JSON.stringify(part.output),
          })
        }
      }
      continue
    }
  }
  } // end else (no compactedOutput)

  const tools = (options.tools ?? [])
    .filter((t): t is LanguageModelV2FunctionTool => t.type === "function")
    .map((t) => ({
      type: "function",
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema,
    }))

  // Extract provider options (reasoningEffort, serviceTier, store, etc.)
  // These come through AI SDK's providerOptions under the "openai" key
  const po = (options.providerOptions?.["openai"] ?? {}) as Record<string, unknown>

  // Build reasoning field (codex-rs: Reasoning { effort, summary })
  const reasoning: Record<string, unknown> | undefined =
    po["reasoningEffort"] || po["reasoningSummary"]
      ? {
          ...(po["reasoningEffort"] ? { effort: po["reasoningEffort"] } : {}),
          ...(po["reasoningSummary"] ? { summary: po["reasoningSummary"] } : {}),
        }
      : undefined

  return {
    model: modelId,
    instructions,
    input,
    tools,
    tool_choice:
      options.toolChoice?.type === "none" ? "none"
      : options.toolChoice?.type === "required" ? "required"
      : options.toolChoice?.type === "tool" ? (options.toolChoice as any).toolName
      : "auto",
    parallel_tool_calls: true,
    stream: true,
    include: ["reasoning.encrypted_content"],
    store: false,

    // Reasoning controls (effort level + summary mode)
    ...(reasoning ? { reasoning } : {}),
    // Service tier (priority, default, etc.)
    ...(po["serviceTier"] ? { service_tier: po["serviceTier"] } : {}),
    // Inline compaction: server auto-compacts when token count crosses threshold
    ...(extra?.compactThreshold
      ? { context_management: [{ type: "compaction", compact_threshold: extra.compactThreshold }] }
      : {}),

    // Prompt cache key for server-side prefix caching
    prompt_cache_key: extra?.promptCacheKey ?? "",

    // Host fields — consumed by C process, stripped before API call
    access_token: auth.accessToken ?? "",
    account_id: auth.accountId ?? "",
    conversation_id: extra?.conversationId ?? "",
    turn_state: extra?.turnState ?? null,
    beta_features: extra?.betaFeatures ?? null,
  }
}

// --------------------------------------------------------------------------
// Parse JSONL event from C process → LanguageModelV2StreamPart
// --------------------------------------------------------------------------

function* parseJsonlEvent(line: string): Generator<LanguageModelV2StreamPart> {
  let event: any
  try {
    event = JSON.parse(line)
  } catch {
    return
  }

  switch (event.type) {
    case "created":
      yield { type: "stream-start", warnings: [] }
      break

    case "text_delta":
      if (event.delta) {
        yield { type: "text-delta", delta: event.delta, id: "text-0" }
      }
      break

    case "reasoning_delta":
    case "reasoning_summary_delta":
      if (event.delta) {
        yield { type: "reasoning-delta", delta: event.delta, id: "reasoning-0" }
      }
      break

    case "reasoning_part_added":
      yield { type: "reasoning-start", id: `reasoning-${event.index ?? 0}` }
      break

    case "item_done": {
      const item = event.item
      if (!item) break

      if (item.type === "function_call") {
        yield {
          type: "tool-call",
          toolCallId: item.call_id ?? `tool-${Date.now()}`,
          toolName: item.name ?? "",
          input: item.arguments ?? "{}",
        }
      }

      if (item.type === "message" && item.end_turn) {
        // Message completed with end_turn — will be followed by "completed"
      }
      break
    }

    case "item_added": {
      const item = event.item
      if (!item) break

      if (item.type === "function_call") {
        yield {
          type: "tool-input-start",
          id: item.call_id ?? `tool-${Date.now()}`,
          toolName: item.name ?? "",
        }
      }
      break
    }

    case "completed": {
      const u = event.usage ?? {}
      const inp = u.input ?? 0
      const out = u.output ?? 0
      const usage: LanguageModelV2Usage = {
        inputTokens: inp,
        outputTokens: out,
        totalTokens: inp + out,
      }
      if (event.response_id) {
        yield {
          type: "response-metadata",
          id: event.response_id,
          modelId: undefined,
          timestamp: undefined,
        } as LanguageModelV2StreamPart
      }
      yield {
        type: "finish",
        usage,
        finishReason: "stop" as LanguageModelV2FinishReason,
        providerMetadata: u.reasoning
          ? { openai: { reasoningTokens: u.reasoning } }
          : undefined,
      }
      break
    }

    case "failed": {
      yield {
        type: "error",
        error: new Error(event.error_message ?? `Codex error ${event.error_code}`),
      }
      yield {
        type: "finish",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "error" as LanguageModelV2FinishReason,
      }
      break
    }

    case "rate_limits":
      // Rate limit info — not mapped to stream parts (handled by quota system)
      break

    case "incomplete":
      yield {
        type: "finish",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "length" as LanguageModelV2FinishReason,
      }
      break
  }
}

// --------------------------------------------------------------------------
// CodexLanguageModel
// --------------------------------------------------------------------------

export class CodexLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const
  readonly provider = "codex"
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  private auth: { accessToken?: string; accountId?: string }
  /** Session-stable cache key for server-side prompt prefix caching */
  private sessionCacheKey = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  /** Sticky routing token captured from last response */
  private turnState: string | undefined
  /** WebSocket connection (reused across requests in same session) */
  private wsClient: CodexWebSocket | null = null
  /** Inline compaction threshold (tokens). When set, server auto-compacts. */
  private compactThreshold: number | undefined
  /**
   * Opaque compacted output from /responses/compact.
   * When set, these items replace conversation history as the input prefix
   * on the next request. Consumed once (cleared after first use).
   * Per API spec: "Do not prune /responses/compact output."
   */
  private compactedOutput: unknown[] | undefined

  constructor(modelId: string, auth?: { accessToken?: string; accountId?: string }, contextLimit?: number) {
    this.modelId = modelId
    this.auth = auth ?? {}
    // Auto-set inline compaction threshold at ~80% of context window
    if (contextLimit && contextLimit > 0) {
      this.compactThreshold = Math.floor(contextLimit * 0.8)
    }
  }

  setAuth(auth: { accessToken?: string; accountId?: string }) {
    this.auth = auth
  }

  /** Reset turn state on new user turn (fresh routing) */
  resetTurnState() {
    this.turnState = undefined
  }

  /**
   * Set inline compaction threshold. When set, every request includes
   * context_management=[{type:"compaction", compact_threshold: N}].
   * Server auto-compacts when rendered token count crosses the threshold.
   */
  setCompactThreshold(tokens: number | undefined) {
    this.compactThreshold = tokens
  }



  /**
   * Store opaque compacted output from /responses/compact.
   * These items will replace conversation history as the input prefix
   * on the next doStream() call, then be cleared.
   */
  setCompactedOutput(items: unknown[]) {
    this.compactedOutput = items
  }

  /**
   * Prewarm: establish WebSocket and send generate=false to warm server cache.
   * Should be called at session start or after idle period.
   * Returns true if prewarm succeeded.
   */
  async prewarm(options: LanguageModelV2CallOptions): Promise<boolean> {
    const auth = {
      accessToken: this.auth.accessToken ?? "",
      accountId: this.auth.accountId ?? "",
    }

    if (!this.wsClient) {
      this.wsClient = new CodexWebSocket(
        { accessToken: auth.accessToken, accountId: auth.accountId },
        undefined,
        this.turnState,
      )
    }

    if (this.wsClient.isDisabled) return false

    const connected = await this.wsClient.connect()
    if (!connected) return false

    const body = promptToRequestBody(this.modelId, options, auth, {
      promptCacheKey: this.sessionCacheKey,
      turnState: this.turnState,
    })

    const result = await this.wsClient.prewarm({
      type: "response.create",
      model: body.model as string,
      instructions: body.instructions as string,
      input: body.input as unknown[],
      tools: body.tools as unknown[],
      tool_choice: body.tool_choice as string,
      parallel_tool_calls: body.parallel_tool_calls as boolean,
      stream: true,
      include: body.include as string[],
      prompt_cache_key: (body.prompt_cache_key as string) || undefined,
    })

    if (result) {
      log.info("codex prewarm succeeded", { responseId: this.wsClient.responseId })
    }

    return result
  }

  /** Close WebSocket connection (cleanup) */
  closeWebSocket() {
    this.wsClient?.close()
    this.wsClient = null
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const { stream } = await this.doStream(options)
    const reader = stream.getReader()

    const content: LanguageModelV2Content[] = []
    let finishReason: LanguageModelV2FinishReason = "stop"
    let usage: LanguageModelV2Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let textAccum = ""
    let reasoningAccum = ""
    // Collect tool call inputs by id (tool-input-start → tool-input-delta → tool-input-end)
    const toolInputs = new Map<string, { toolName: string; input: string }>()
    let activeToolId: string | undefined

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      switch (value.type) {
        case "text-delta":
          textAccum += value.delta
          break
        case "reasoning-delta":
          reasoningAccum += value.delta
          break
        case "tool-call":
          content.push({
            type: "tool-call",
            toolCallId: value.toolCallId,
            toolName: value.toolName,
            input: value.input,
          })
          break
        case "tool-input-start":
          activeToolId = value.id
          toolInputs.set(value.id, { toolName: value.toolName, input: "" })
          break
        case "tool-input-delta":
          if (toolInputs.has(value.id)) {
            toolInputs.get(value.id)!.input += value.delta
          }
          break
        case "tool-input-end":
          if (toolInputs.has(value.id)) {
            const t = toolInputs.get(value.id)!
            content.push({
              type: "tool-call",
              toolCallId: value.id,
              toolName: t.toolName,
              input: t.input,
            })
            toolInputs.delete(value.id)
          }
          break
        case "finish":
          finishReason = value.finishReason
          usage = value.usage
          break
      }
    }

    if (textAccum) content.push({ type: "text", text: textAccum })
    if (reasoningAccum) content.push({ type: "reasoning", text: reasoningAccum } as LanguageModelV2Content)

    return {
      content,
      finishReason,
      usage,
      warnings: [] as LanguageModelV2CallWarning[],
    }
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>
    request?: { body?: unknown }
    response?: { headers?: Record<string, string> }
  }> {
    // Auth is set by llm.ts via setAuth() before each request.
    // No Auth.get() call — provider doesn't manage auth.
    const auth = {
      accessToken: this.auth.accessToken ?? "",
      accountId: this.auth.accountId ?? "",
    }
    if (!auth.accessToken) {
      log.warn("codex doStream: no access token — setAuth() not called before request")
    }

    // Consume compacted output (one-shot: cleared after use)
    const compactedOutput = this.compactedOutput
    this.compactedOutput = undefined

    const body = promptToRequestBody(this.modelId, options, auth, {
      promptCacheKey: this.sessionCacheKey,
      compactThreshold: this.compactThreshold,
      turnState: this.turnState,
      compactedOutput,
    })

    // --- WebSocket transport (preferred) ---
    const wsResult = await this.tryWebSocket(body, auth)
    if (wsResult) return wsResult

    // --- C binary transport (fallback) ---
    return this.doCBinaryStream(body, auth)
  }

  /**
   * Try WebSocket transport. Returns null if unavailable or disabled.
   * Passes fresh auth on every call (handles token refresh/reconnect).
   */
  private async tryWebSocket(
    body: Record<string, unknown>,
    auth: { accessToken: string; accountId: string },
  ): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>
    request?: { body?: unknown }
  } | null> {
    // Lazily create WebSocket client per session
    if (!this.wsClient) {
      this.wsClient = new CodexWebSocket(
        { accessToken: auth.accessToken, accountId: auth.accountId },
        undefined,
        this.turnState,
      )
    }

    if (this.wsClient.isDisabled) return null

    // Always update auth before connect (tokens expire and rotate)
    this.wsClient.updateAuth({
      accessToken: auth.accessToken,
      accountId: auth.accountId,
    })

    const connected = await this.wsClient.connect()
    if (!connected) return null

    // Build WebSocket request (strip host-only fields consumed by C binary)
    // Delta detection is handled inside CodexWebSocket.stream() → prepareWireRequest()
    const wsRequest: CodexWsRequest = {
      type: "response.create",
      model: body.model as string,
      instructions: body.instructions as string,
      input: body.input as unknown[],
      tools: body.tools as unknown[],
      tool_choice: body.tool_choice as string,
      parallel_tool_calls: body.parallel_tool_calls as boolean,
      stream: true,
      include: body.include as string[],
      prompt_cache_key: (body.prompt_cache_key as string) || undefined,
    }

    const wsStream = await this.wsClient.stream(wsRequest)
    if (!wsStream) return null

    log.info("codex ws stream started", {
      model: wsRequest.model,
      inputItems: wsRequest.input.length,
    })

    return { stream: wsStream, request: { body: wsRequest } }
  }

  /**
   * Fallback: spawn C binary for HTTP SSE transport.
   */
  private async doCBinaryStream(
    body: Record<string, unknown>,
    auth: { accessToken: string; accountId: string },
  ): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>
    request?: { body?: unknown }
  }> {
    const binaryPath = getBinaryPath()
    if (!binaryPath) {
      throw new Error(
        "codex-provider binary not found. Build with: " +
        "cd packages/opencode-codex-provider/build && cmake .. && cmake --build ."
      )
    }

    const bodyJson = JSON.stringify(body)

    log.info("codex-provider spawn", {
      model: this.modelId,
      bodyBytes: bodyJson.length,
      hasAuth: !!auth.accessToken,
      authType: auth.accessToken ? "oauth" : "none",
    })

    // Spawn C process: stdin JSON → stdout JSONL
    const proc = Bun.spawn([binaryPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CODEX_PROVIDER_VERSION: "0.1.0",
      },
    })

    // Write request to stdin, close to signal EOF
    const encoder = new TextEncoder()
    proc.stdin.write(encoder.encode(bodyJson))
    proc.stdin.end()

    // Log stderr (non-blocking)
    ;(async () => {
      try {
        const text = await new Response(proc.stderr).text()
        if (text.trim()) {
          log.warn("codex-provider stderr", { output: text.trim().slice(0, 500) })
        }
      } catch {}
    })()

    // Build ReadableStream from stdout JSONL
    const stdout = proc.stdout
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    let lineBuf = ""
    const self = this

    const processLine = (line: string, controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>) => {
      // Intercept response_metadata — not a stream part, captures turn state
      try {
        const parsed = JSON.parse(line)
        if (parsed.type === "response_metadata") {
          if (parsed.turn_state) self.turnState = parsed.turn_state
          return
        }
      } catch {}

      for (const part of parseJsonlEvent(line)) {
        controller.enqueue(part)
      }
    }

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async pull(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read()

            if (done) {
              if (lineBuf.trim()) processLine(lineBuf.trim(), controller)
              controller.close()
              return
            }

            lineBuf += decoder.decode(value, { stream: true })

            let idx: number
            while ((idx = lineBuf.indexOf("\n")) !== -1) {
              const line = lineBuf.slice(0, idx).trim()
              lineBuf = lineBuf.slice(idx + 1)
              if (line) processLine(line, controller)
            }
          }
        } catch (err) {
          controller.error(err)
        }
      },

      cancel() {
        reader.releaseLock()
        proc.kill()
      },
    })

    return {
      stream,
      request: { body },
    }
  }
}

/**
 * Check if the native codex-provider binary is available.
 */
export function isCodexNativeAvailable(): boolean {
  return getBinaryPath() !== null
}

/**
 * Opportunistically preconnect WebSocket for a CodexLanguageModel.
 * Call from chat.message hook to overlap TCP+TLS handshake with prompt construction.
 * Mirrors codex-rs preconnect_websocket() — connection only, no prompt payload.
 *
 * Pass the LanguageModelV2 obtained from Provider.getLanguage(); if it's a
 * CodexLanguageModel the WebSocket handshake fires in the background.
 */
export async function codexPreconnectWebSocket(languageModel: unknown): Promise<void> {
  if (!(languageModel instanceof CodexLanguageModel)) return
  const model = languageModel as CodexLanguageModel

  try {
    // Use whatever auth is currently on the model instance.
    // It may be stale from construction, but doStream() will
    // refresh it via setAuth() before the actual request.
    const auth = {
      accessToken: model["auth"]?.accessToken ?? "",
      accountId: model["auth"]?.accountId ?? "",
    }
    if (!auth.accessToken) return

    if (!model["wsClient"]) {
      model["wsClient"] = new CodexWebSocket(
        { accessToken: auth.accessToken, accountId: auth.accountId },
      )
    } else {
      model["wsClient"].updateAuth(auth)
    }

    if (model["wsClient"].isDisabled) return

    await model["wsClient"].connect()
    log.info("codex ws preconnected")
  } catch (err) {
    log.warn("codex ws preconnect failed", { error: String(err) })
  }
}
