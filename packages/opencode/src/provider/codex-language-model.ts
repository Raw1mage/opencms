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
  extra?: { conversationId?: string; turnState?: string; betaFeatures?: string },
): Record<string, unknown> {
  let instructions = ""
  const input: unknown[] = []

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
          contentItems.push({
            type: "input_image",
            image_url: typeof part.data === "string" ? part.data : undefined,
          })
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
          input.push({
            type: "reasoning",
            summary: [{ type: "summary_text", text: part.text }],
          })
        } else if (part.type === "tool-call") {
          input.push({
            type: "function_call",
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: typeof part.args === "string" ? part.args : JSON.stringify(part.args),
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
            output: typeof part.result === "string" ? part.result : JSON.stringify(part.result),
          })
        }
      }
      continue
    }
  }

  const tools = (options.tools ?? [])
    .filter((t): t is LanguageModelV2FunctionTool => t.type === "function")
    .map((t) => ({
      type: "function",
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters,
    }))

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
          toolCallType: "function" as const,
          toolCallId: item.call_id ?? `tool-${Date.now()}`,
          toolName: item.name ?? "",
          args: item.arguments ?? "{}",
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
      const usage: LanguageModelV2Usage = {
        inputTokens: u.input ?? 0,
        outputTokens: u.output ?? 0,
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
        usage: { inputTokens: 0, outputTokens: 0 },
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
        usage: { inputTokens: 0, outputTokens: 0 },
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

  constructor(modelId: string, auth?: { accessToken?: string; accountId?: string }) {
    this.modelId = modelId
    this.auth = auth ?? {}
  }

  setAuth(auth: { accessToken?: string; accountId?: string }) {
    this.auth = auth
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const { stream } = await this.doStream(options)
    const reader = stream.getReader()

    const content: LanguageModelV2Content[] = []
    let finishReason: LanguageModelV2FinishReason = "stop"
    let usage: LanguageModelV2Usage = { inputTokens: 0, outputTokens: 0 }
    let textAccum = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === "text-delta") textAccum += value.delta
      else if (value.type === "finish") {
        finishReason = value.finishReason
        usage = value.usage
      }
    }

    if (textAccum) content.push({ type: "text", text: textAccum })

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
    const binaryPath = getBinaryPath()
    if (!binaryPath) {
      throw new Error(
        "codex-provider binary not found. Build with: " +
        "cd packages/opencode-codex-provider/build && cmake .. && cmake --build ."
      )
    }

    const body = promptToRequestBody(this.modelId, options, this.auth)
    const bodyJson = JSON.stringify(body)

    log.info("codex-provider spawn", {
      model: this.modelId,
      bodyBytes: bodyJson.length,
      hasAuth: !!(this.auth.accessToken),
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

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async pull(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read()

            if (done) {
              // Flush remaining buffer
              if (lineBuf.trim()) {
                for (const part of parseJsonlEvent(lineBuf.trim())) {
                  controller.enqueue(part)
                }
              }
              controller.close()
              return
            }

            lineBuf += decoder.decode(value, { stream: true })

            // Emit complete lines
            let idx: number
            while ((idx = lineBuf.indexOf("\n")) !== -1) {
              const line = lineBuf.slice(0, idx).trim()
              lineBuf = lineBuf.slice(idx + 1)

              if (line) {
                for (const part of parseJsonlEvent(line)) {
                  controller.enqueue(part)
                }
              }
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
