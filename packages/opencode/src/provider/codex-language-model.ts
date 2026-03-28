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
import { Subprocess } from "bun"
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
// Convert AI SDK prompt → Responses API format
// --------------------------------------------------------------------------

function promptToRequestBody(
  modelId: string,
  options: LanguageModelV2CallOptions,
  auth: { accessToken?: string; accountId?: string },
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
          contentItems.push({ type: "input_image", image_url: part.data })
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

  // Build tools array
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
    ...(options.providerOptions?.openai?.service_tier && {
      service_tier: options.providerOptions.openai.service_tier,
    }),

    // Host fields — consumed by C process, stripped before API call
    access_token: auth.accessToken ?? "",
    account_id: auth.accountId ?? "",
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
      break
    }

    case "completed": {
      const u = event.usage ?? {}
      const usage: LanguageModelV2Usage = {
        inputTokens: u.input ?? 0,
        outputTokens: u.output ?? 0,
      }
      yield {
        type: "response-metadata",
        id: event.response_id ?? undefined,
        modelId: undefined,
        timestamp: undefined,
      } as LanguageModelV2StreamPart
      yield {
        type: "finish",
        usage,
        finishReason: "stop" as LanguageModelV2FinishReason,
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

  /** Update auth tokens (called by auth hook before each request) */
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
        "codex-provider binary not found. Build it with: " +
        "cd packages/opencode-codex-provider && mkdir build && cd build && cmake .. && cmake --build ."
      )
    }

    const body = promptToRequestBody(this.modelId, options, this.auth)
    const bodyJson = JSON.stringify(body)

    log.info("spawning codex-provider", {
      model: this.modelId,
      bodyBytes: bodyJson.length,
    })

    // Spawn the C process
    const proc = Bun.spawn([binaryPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // C process reads these for URL resolution and headers
        CODEX_PROVIDER_VERSION: "0.1.0",
      },
    })

    // Write request to stdin, then close
    proc.stdin.write(bodyJson)
    proc.stdin.end()

    // Read stderr for diagnostics (non-blocking, fire-and-forget)
    ;(async () => {
      try {
        const stderrText = await new Response(proc.stderr).text()
        if (stderrText.trim()) {
          log.warn("codex-provider stderr", { output: stderrText.trim() })
        }
      } catch { /* ignore */ }
    })()

    // Create ReadableStream from stdout JSONL
    const stdout = proc.stdout
    const decoder = new TextDecoder()
    let lineBuf = ""

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async pull(controller) {
        const reader = stdout.getReader()

        try {
          while (true) {
            const { done, value } = await reader.read()

            if (done) {
              // Process any remaining data in buffer
              if (lineBuf.trim()) {
                for (const part of parseJsonlEvent(lineBuf.trim())) {
                  controller.enqueue(part)
                }
              }
              controller.close()
              return
            }

            lineBuf += decoder.decode(value, { stream: true })

            // Process complete lines
            let newlineIdx: number
            while ((newlineIdx = lineBuf.indexOf("\n")) !== -1) {
              const line = lineBuf.slice(0, newlineIdx).trim()
              lineBuf = lineBuf.slice(newlineIdx + 1)

              if (line) {
                for (const part of parseJsonlEvent(line)) {
                  controller.enqueue(part)
                }
              }
            }
          }
        } catch (err) {
          controller.error(err)
        } finally {
          reader.releaseLock()
        }
      },
    })

    return {
      stream,
      request: { body },
    }
  }
}
