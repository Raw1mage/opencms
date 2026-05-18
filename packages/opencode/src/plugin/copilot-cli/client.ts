/**
 * Raw HTTP client for Copilot API (DD-9: no AI SDK runtime dependency).
 *
 * Directly talks to api.githubcopilot.com via fetch + SSE streaming.
 */

import { Log } from "../../util/log"
import { Installation } from "../../installation"
import { getBearer, getProfile } from "./auth"

const log = Log.create({ service: "copilot-cli.client" })

// ---------------------------------------------------------------------------
// SSE Parser — converts a ReadableStream<Uint8Array> into async iterable of
// OpenAI-style SSE events. Self-contained, no AI SDK dependency.
// ---------------------------------------------------------------------------

export interface SSEEvent {
  event?: string
  data: string
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop()! // keep incomplete last line

      let currentEvent: string | undefined
      let currentData: string[] = []

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          currentData.push(line.slice(5).trim())
        } else if (line === "" && currentData.length > 0) {
          // Empty line = end of event
          const data = currentData.join("\n")
          if (data !== "[DONE]") {
            yield { event: currentEvent, data }
          }
          currentEvent = undefined
          currentData = []
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const profile = getProfile()
  return profile?.endpoints.api ?? "https://api.githubcopilot.com"
}

interface RequestOptions {
  model: string
  /** Whether this is an agent turn (not user-initiated). */
  isAgent?: boolean
  /** Whether the request contains vision/image content. */
  isVision?: boolean
}

async function buildHeaders(options: RequestOptions): Promise<Record<string, string>> {
  const bearer = await getBearer()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${bearer}`,
    "User-Agent": `opencode/${Installation.VERSION}`,
    "Openai-Intent": "conversation-edits",
    "x-initiator": options.isAgent ? "agent" : "user",
  }
  if (options.isVision) {
    headers["Copilot-Vision-Request"] = "true"
  }
  return headers
}

// ---------------------------------------------------------------------------
// Chat Completions API
// ---------------------------------------------------------------------------

export interface CompletionsRequest {
  model: string
  messages: any[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: any[]
  tool_choice?: any
  [key: string]: any
}

export interface CompletionsChunk {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export async function* streamCompletions(
  request: CompletionsRequest,
  options: RequestOptions,
): AsyncIterable<CompletionsChunk> {
  const url = `${getBaseUrl()}/chat/completions`
  const headers = await buildHeaders(options)

  const body = { ...request, stream: true }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`Copilot completions API error ${resp.status}: ${text.slice(0, 500)}`)
  }

  if (!resp.body) throw new Error("No response body")

  for await (const event of parseSSE(resp.body)) {
    try {
      const chunk = JSON.parse(event.data) as CompletionsChunk
      yield chunk
    } catch {
      log.warn("failed to parse completions SSE chunk", { data: event.data.slice(0, 200) })
    }
  }
}

/** Non-streaming completions call (used by doGenerate). */
export async function callCompletions(
  request: CompletionsRequest,
  options: RequestOptions,
): Promise<{
  content: string | null
  toolCalls: any[]
  finishReason: string
  usage: { promptTokens: number; completionTokens: number }
}> {
  const url = `${getBaseUrl()}/chat/completions`
  const headers = await buildHeaders(options)
  headers["Accept"] = "application/json"

  const body = { ...request, stream: false }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`Copilot completions API error ${resp.status}: ${text.slice(0, 500)}`)
  }

  const data = (await resp.json()) as any
  const choice = data.choices?.[0]

  return {
    content: choice?.message?.content ?? null,
    toolCalls: choice?.message?.tool_calls ?? [],
    finishReason: choice?.finish_reason ?? "stop",
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Responses API
// ---------------------------------------------------------------------------

export interface ResponsesRequest {
  model: string
  input: any[]
  stream?: boolean
  temperature?: number
  max_output_tokens?: number
  tools?: any[]
  tool_choice?: any
  previous_response_id?: string
  [key: string]: any
}

export interface ResponsesChunk {
  type: string
  [key: string]: any
}

export async function* streamResponses(
  request: ResponsesRequest,
  options: RequestOptions,
): AsyncIterable<ResponsesChunk> {
  const url = `${getBaseUrl()}/responses`
  const headers = await buildHeaders(options)

  const body = { ...request, stream: true }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`Copilot responses API error ${resp.status}: ${text.slice(0, 500)}`)
  }

  if (!resp.body) throw new Error("No response body")

  for await (const event of parseSSE(resp.body)) {
    try {
      const chunk = JSON.parse(event.data) as ResponsesChunk
      yield chunk
    } catch {
      log.warn("failed to parse responses SSE chunk", { data: event.data.slice(0, 200) })
    }
  }
}
