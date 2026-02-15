import { CODE_ASSIST_HEADERS, GEMINI_CODE_ASSIST_ENDPOINT, GEMINI_PUBLIC_ENDPOINT } from "../constants"
import { logGeminiDebugResponse, type GeminiDebugContext } from "./debug"
import {
  enhanceGeminiErrorResponse,
  extractUsageMetadata,
  normalizeThinkingConfig,
  parseGeminiApiBody,
  rewriteGeminiPreviewAccessError,
  type GeminiApiBody,
  type GeminiUsageMetadata,
} from "./request-helpers"
import { debugCheckpoint } from "../../../util/debug"

const STREAM_ACTION = "streamGenerateContent"
const MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
}

interface GeminiFunctionCallPart {
  functionCall?: {
    name: string
    args?: Record<string, unknown>
    [key: string]: unknown
  }
  thoughtSignature?: string
  [key: string]: unknown
}

interface GeminiContentPart {
  role?: string
  parts?: GeminiFunctionCallPart[]
  [key: string]: unknown
}

interface OpenAIToolCall {
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface OpenAIMessage {
  role?: string
  content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
  [key: string]: unknown
}

/**
 * Transforms OpenAI tool_calls to Gemini functionCall format and adds thoughtSignature.
 * This ensures compatibility when OpenCode sends OpenAI-format function calls.
 */
function transformOpenAIToolCalls(requestPayload: Record<string, unknown>): void {
  const messages = requestPayload.messages
  debugCheckpoint("gemini-request", "transformOpenAIToolCalls called", {
    hasMessages: !!messages,
    messageCount: Array.isArray(messages) ? messages.length : 0,
  })

  if (!messages || !Array.isArray(messages)) {
    return
  }

  for (const message of messages) {
    if (message && typeof message === "object") {
      const msgObj = message as OpenAIMessage
      const toolCalls = msgObj.tool_calls
      if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
        const parts: GeminiFunctionCallPart[] = []

        if (typeof msgObj.content === "string" && msgObj.content.length > 0) {
          parts.push({ text: msgObj.content })
        }

        for (const toolCall of toolCalls) {
          if (toolCall && typeof toolCall === "object") {
            const functionObj = toolCall.function
            if (functionObj && typeof functionObj === "object") {
              const name = functionObj.name
              const argsStr = functionObj.arguments
              let args: Record<string, unknown> = {}
              if (typeof argsStr === "string") {
                try {
                  args = JSON.parse(argsStr) as Record<string, unknown>
                } catch {
                  // Fallback for invalid JSON args
                  args = {}
                }
              }

              parts.push({
                functionCall: {
                  name: name ?? "",
                  args,
                },
                thoughtSignature: "skip_thought_signature_validator",
              })
            }
          }
        }

        msgObj.parts = parts
        delete msgObj.tool_calls
        delete msgObj.content
      }
    }
  }
}

/**
 * Adds thoughtSignature to function call parts in the request payload.
 * Gemini 3+ models require thoughtSignature for function calls when using thinking capabilities.
 * This must be applied to all content blocks in the conversation history.
 * Handles both flat contents arrays and nested request.contents (wrapped bodies).
 */
function addThoughtSignaturesToFunctionCalls(requestPayload: Record<string, unknown>): void {
  let signaturesAdded = 0
  let functionCallsFound = 0

  const processContents = (contents: unknown, path: string): void => {
    if (!contents || !Array.isArray(contents)) {
      debugCheckpoint("gemini-request", `processContents: no contents at ${path}`, { contents: typeof contents })
      return
    }

    debugCheckpoint("gemini-request", `processContents: processing ${path}`, { contentCount: contents.length })

    for (let i = 0; i < contents.length; i++) {
      const content = contents[i]
      if (content && typeof content === "object") {
        const contentObj = content as Record<string, unknown>
        const parts = contentObj.parts
        if (parts && Array.isArray(parts)) {
          for (let j = 0; j < parts.length; j++) {
            const part = parts[j]
            if (part && typeof part === "object") {
              const partObj = part as Record<string, unknown>
              if (partObj.functionCall) {
                functionCallsFound++
                const functionCall = partObj.functionCall
                const funcName =
                  functionCall && typeof functionCall === "object" && "name" in functionCall
                    ? ((functionCall as { name?: unknown }).name ?? "unknown")
                    : "unknown"
                if (!partObj.thoughtSignature) {
                  partObj.thoughtSignature = "skip_thought_signature_validator"
                  signaturesAdded++
                  debugCheckpoint("gemini-request", `Added thoughtSignature to functionCall`, {
                    path: `${path}[${i}].parts[${j}]`,
                    functionName: funcName,
                  })
                } else {
                  debugCheckpoint("gemini-request", `functionCall already has thoughtSignature`, {
                    path: `${path}[${i}].parts[${j}]`,
                    functionName: funcName,
                  })
                }
              }
            }
          }
        }
      }
    }
  }

  debugCheckpoint("gemini-request", "addThoughtSignaturesToFunctionCalls called", {
    hasContents: !!requestPayload.contents,
    hasNestedRequest: !!(requestPayload.request && typeof requestPayload.request === "object"),
    payloadKeys: Object.keys(requestPayload),
  })

  processContents(requestPayload.contents, "contents")

  const nestedRequest = requestPayload.request
  if (nestedRequest && typeof nestedRequest === "object") {
    const requestObj = nestedRequest as Record<string, unknown>
    processContents(requestObj.contents, "request.contents")
  }

  debugCheckpoint("gemini-request", "addThoughtSignaturesToFunctionCalls completed", {
    functionCallsFound,
    signaturesAdded,
  })
}

/**
 * Detects Gemini/Generative Language API requests by URL.
 * @param input Request target passed to fetch.
 * @returns True when the URL targets generativelanguage.googleapis.com.
 */
export function isGenerativeLanguageRequest(input: RequestInfo): boolean {
  const url = toRequestUrlString(input)
  return url.includes("generativelanguage.googleapis.com") || url.startsWith("/v1/") || url.startsWith("/models/")
}

/**
 * Rewrites SSE payload lines so downstream consumers see only the inner `response` objects.
 */
function transformStreamingLine(line: string): string {
  if (!line.startsWith("data:")) {
    return line
  }
  const json = line.slice(5).trim()
  if (!json) {
    return line
  }
  try {
    const parsed = JSON.parse(json) as { response?: unknown }
    if (parsed.response !== undefined) {
      return `data: ${JSON.stringify(parsed.response)}`
    }
  } catch (_) {
    // Ignore JSON parse errors for non-JSON lines
  }
  return line
}

/**
 * Streams SSE payloads, rewriting data lines on the fly.
 */
function transformStreamingPayloadStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = stream.getReader()
      const pump = (): void => {
        reader!
          .read()
          .then(({ done, value }) => {
            if (done) {
              buffer += decoder.decode()
              if (buffer.length > 0) {
                controller.enqueue(encoder.encode(transformStreamingLine(buffer)))
              }
              controller.close()
              return
            }

            buffer += decoder.decode(value, { stream: true })

            let newlineIndex = buffer.indexOf("\n")
            while (newlineIndex !== -1) {
              const line = buffer.slice(0, newlineIndex)
              buffer = buffer.slice(newlineIndex + 1)
              const hasCarriageReturn = line.endsWith("\r")
              const rawLine = hasCarriageReturn ? line.slice(0, -1) : line
              const transformed = transformStreamingLine(rawLine)
              const suffix = hasCarriageReturn ? "\r\n" : "\n"
              controller.enqueue(encoder.encode(`${transformed}${suffix}`))
              newlineIndex = buffer.indexOf("\n")
            }

            pump()
          })
          .catch((error) => {
            controller.error(error)
          })
      }

      pump()
    },
    cancel(reason) {
      if (reader) {
        reader.cancel(reason).catch(() => {
          // Ignore cancel error
        })
      }
    },
  })
}

/**
 * Rewrites OpenAI-style requests into Gemini Code Assist shape, normalizing model, headers,
 * optional cached_content, and thinking config. Also toggles streaming mode for SSE actions.
 */
export function prepareGeminiRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
  isApiKey: boolean = false,
): { request: RequestInfo; init: RequestInit; streaming: boolean; requestedModel?: string } {
  const baseInit: RequestInit = { ...init }
  const headers = new Headers(init?.headers ?? {})

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    }
  }

  if (isApiKey) {
    headers.set("x-goog-api-key", accessToken)
    headers.delete("Authorization")
  } else {
    headers.set("Authorization", `Bearer ${accessToken}`)
    headers.delete("x-api-key")
  }

  const match = toRequestUrlString(input).match(/\/models\/([^:]+):(\w+)/)
  if (!match) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    }
  }

  const [, rawModel = "", rawAction = ""] = match
  const effectiveModel = MODEL_FALLBACKS[rawModel] ?? rawModel
  const streaming = rawAction === STREAM_ACTION
  
  // Choose endpoint and URL structure based on auth type
  let transformedUrl: string
  if (isApiKey) {
    // Public API: /v1beta/models/{model}:{action}
    transformedUrl = `${GEMINI_PUBLIC_ENDPOINT}/v1beta/models/${effectiveModel}:${rawAction}${streaming ? "?alt=sse" : ""}`
  } else {
    // Internal API: /v1internal:{action} (model is in body)
    transformedUrl = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`
  }

  let body = baseInit.body
  debugCheckpoint("gemini-request", "prepareGeminiRequest processing body", {
    hasBody: !!baseInit.body,
    bodyType: typeof baseInit.body,
    bodyLength: typeof baseInit.body === "string" ? baseInit.body.length : 0,
    isApiKey,
  })

  if (typeof baseInit.body === "string" && baseInit.body) {
    try {
      const parsedBody = JSON.parse(baseInit.body) as Record<string, unknown>
      const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody

      debugCheckpoint("gemini-request", "Body parsed", {
        isWrapped,
        parsedBodyKeys: Object.keys(parsedBody),
        hasContents: !!parsedBody.contents,
        hasMessages: !!parsedBody.messages,
      })

      if (isWrapped) {
        debugCheckpoint("gemini-request", "Body already wrapped, skipping transformation")
        // If it's already wrapped but we are in API key mode, we might need to UNWRAP it
        // But assuming upstream sends standard Gemini format unless it's already our internal wrapper
        const wrappedBody = {
          ...parsedBody,
          model: effectiveModel,
        } as Record<string, unknown>
        body = JSON.stringify(wrappedBody)
      } else {
        debugCheckpoint("gemini-request", "Body not wrapped, applying transformations")
        const requestPayload: Record<string, unknown> = { ...parsedBody }

        transformOpenAIToolCalls(requestPayload)
        addThoughtSignaturesToFunctionCalls(requestPayload)

        const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined
        const normalizedThinking = normalizeThinkingConfig(rawGenerationConfig?.thinkingConfig)
        if (normalizedThinking) {
          if (rawGenerationConfig) {
            rawGenerationConfig.thinkingConfig = normalizedThinking
            requestPayload.generationConfig = rawGenerationConfig
          } else {
            requestPayload.generationConfig = { thinkingConfig: normalizedThinking }
          }
        } else if (rawGenerationConfig?.thinkingConfig) {
          delete rawGenerationConfig.thinkingConfig
          requestPayload.generationConfig = rawGenerationConfig
        }

        if ("system_instruction" in requestPayload) {
          requestPayload.systemInstruction = requestPayload.system_instruction
          delete requestPayload.system_instruction
        }

        const cachedContentFromExtra =
          typeof requestPayload.extra_body === "object" && requestPayload.extra_body
            ? ((requestPayload.extra_body as Record<string, unknown>).cached_content ??
              (requestPayload.extra_body as Record<string, unknown>).cachedContent)
            : undefined
        const cachedContent =
          (requestPayload.cached_content as string | undefined) ??
          (requestPayload.cachedContent as string | undefined) ??
          (cachedContentFromExtra as string | undefined)
        if (cachedContent) {
          requestPayload.cachedContent = cachedContent
        }

        delete requestPayload.cached_content
        if (requestPayload.extra_body && typeof requestPayload.extra_body === "object") {
          delete (requestPayload.extra_body as Record<string, unknown>).cached_content
          delete (requestPayload.extra_body as Record<string, unknown>).cachedContent
          if (Object.keys(requestPayload.extra_body as Record<string, unknown>).length === 0) {
            delete requestPayload.extra_body
          }
        }

        if ("model" in requestPayload) {
          delete requestPayload.model
        }

        if (isApiKey) {
          // Public API: Use payload directly
          body = JSON.stringify(requestPayload)
        } else {
          // Internal API: Wrap payload
          const wrappedBody = {
            project: projectId,
            model: effectiveModel,
            request: requestPayload,
          }
          body = JSON.stringify(wrappedBody)
        }
      }
    } catch (error) {
      debugCheckpoint("gemini-request", "Failed to transform Gemini request body", { error })
      console.error("Failed to transform Gemini request body:", error)
    }
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream")
  }

  headers.set("User-Agent", CODE_ASSIST_HEADERS["User-Agent"])
  headers.set("X-Goog-Api-Client", CODE_ASSIST_HEADERS["X-Goog-Api-Client"])
  headers.set("Client-Metadata", CODE_ASSIST_HEADERS["Client-Metadata"])

  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel: rawModel,
  }
}

function toRequestUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value
  }
  if (value instanceof URL) {
    return value.toString()
  }
  const candidate = (value as Request).url
  if (candidate) {
    return candidate
  }
  return value.toString()
}

/**
 * Normalizes Gemini responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, rewrites streaming payloads, and logs debug metadata.
 */
export async function transformGeminiResponse(
  response: Response,
  streaming: boolean,
  debugContext?: GeminiDebugContext | null,
  requestedModel?: string,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? ""
  const isJsonResponse = contentType.includes("application/json")
  const isEventStreamResponse = contentType.includes("text/event-stream")

  if (!isJsonResponse && !isEventStreamResponse) {
    logGeminiDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    })
    return response
  }

  try {
    const headers = new Headers(response.headers)

    if (streaming && response.ok && isEventStreamResponse && response.body) {
      logGeminiDebugResponse(debugContext, response, {
        note: "Streaming SSE payload (body omitted)",
        headersOverride: headers,
      })

      return new Response(transformStreamingPayloadStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }

    const text = await response.text()

    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    }

    const parsed: GeminiApiBody | null = !streaming || !isEventStreamResponse ? parseGeminiApiBody(text) : null
    const enhanced = !response.ok && parsed ? enhanceGeminiErrorResponse(parsed, response.status) : null
    if (enhanced?.retryAfterMs) {
      const retryAfterSec = Math.ceil(enhanced.retryAfterMs / 1000).toString()
      headers.set("Retry-After", retryAfterSec)
      headers.set("retry-after-ms", String(enhanced.retryAfterMs))
    }
    const previewPatched = parsed
      ? rewriteGeminiPreviewAccessError(enhanced?.body ?? parsed, response.status, requestedModel)
      : null
    const effectiveBody = previewPatched ?? enhanced?.body ?? parsed ?? undefined

    const usage = effectiveBody ? extractUsageMetadata(effectiveBody) : null
    if (usage?.cachedContentTokenCount !== undefined) {
      headers.set("x-gemini-cached-content-token-count", String(usage.cachedContentTokenCount))
      if (usage.totalTokenCount !== undefined) {
        headers.set("x-gemini-total-token-count", String(usage.totalTokenCount))
      }
      if (usage.promptTokenCount !== undefined) {
        headers.set("x-gemini-prompt-token-count", String(usage.promptTokenCount))
      }
      if (usage.candidatesTokenCount !== undefined) {
        headers.set("x-gemini-candidates-token-count", String(usage.candidatesTokenCount))
      }
    }

    logGeminiDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (buffered)" : undefined,
      headersOverride: headers,
    })

    if (!parsed) {
      return new Response(text, init)
    }

    if (effectiveBody?.response !== undefined) {
      return new Response(JSON.stringify(effectiveBody.response), init)
    }

    if (previewPatched) {
      return new Response(JSON.stringify(previewPatched), init)
    }

    return new Response(text, init)
  } catch (error) {
    debugCheckpoint("gemini-request", "Failed to transform Gemini response", { error })
    logGeminiDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Gemini response",
    })
    console.error("Failed to transform Gemini response:", error)
    return response
  }
}
