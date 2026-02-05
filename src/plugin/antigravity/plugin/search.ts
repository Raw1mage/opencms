/**
 * Google Search Tool Implementation
 *
 * Due to Gemini API limitations, native search tools (googleSearch, urlContext)
 * cannot be combined with function declarations. This module implements a
 * wrapper that makes separate API calls with only the grounding tools enabled.
 */

import {
  ANTIGRAVITY_ENDPOINT,
  GEMINI_CLI_ENDPOINT,
  SEARCH_MODEL,
  SEARCH_THINKING_BUDGET_DEEP,
  SEARCH_THINKING_BUDGET_FAST,
  SEARCH_TIMEOUT_MS,
  SEARCH_SYSTEM_INSTRUCTION,
  getRandomizedHeaders,
  type HeaderStyle,
} from "../constants"
import { env } from "node:process"
import { createLogger } from "./logger"
import { debugCheckpoint } from "../../../util/debug"
import { resolveModelForHeaderStyle } from "./transform/model-resolver"

const log = createLogger("search")

// ============================================================================
// Types
// ============================================================================

interface GroundingChunk {
  web?: {
    uri?: string
    title?: string
  }
}

interface GroundingSupport {
  segment?: {
    startIndex?: number
    endIndex?: number
    text?: string
  }
  groundingChunkIndices?: number[]
}

interface GroundingMetadata {
  webSearchQueries?: string[]
  groundingChunks?: GroundingChunk[]
  groundingSupports?: GroundingSupport[]
  searchEntryPoint?: {
    renderedContent?: string
  }
}

interface UrlMetadata {
  retrieved_url?: string
  url_retrieval_status?: string
}

interface UrlContextMetadata {
  url_metadata?: UrlMetadata[]
}

interface SearchResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
      role?: string
    }
    finishReason?: string
    groundingMetadata?: GroundingMetadata
    urlContextMetadata?: UrlContextMetadata
  }>
  error?: {
    code?: number
    message?: string
    status?: string
  }
}

interface AntigravitySearchResponse {
  response?: SearchResponse
  error?: {
    code?: number
    message?: string
    status?: string
  }
}

export interface SearchArgs {
  query: string
  urls?: string[]
  thinking?: boolean
}

export interface SearchResult {
  text: string
  sources: Array<{ title: string; url: string }>
  searchQueries: string[]
  urlsRetrieved: Array<{ url: string; status: string }>
}

export interface SearchResponseResult {
  ok: boolean
  output: string
  error?: string
  status?: number
}

// ============================================================================
// Helper Functions
// ============================================================================

let sessionCounter = 0
const sessionPrefix = `search-${Date.now().toString(36)}`

function generateRequestId(): string {
  return `search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function getSessionId(): string {
  sessionCounter++
  return `${sessionPrefix}-${sessionCounter}`
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function titleFromUrl(url: string): string {
  const host = url.replace(/^https?:\/\//, "").split("/")[0]
  return host || url
}

function formatSearchResult(result: SearchResult): string {
  const lines: string[] = []

  lines.push("## Search Results\n")
  lines.push(result.text)
  lines.push("")

  if (result.sources.length > 0) {
    lines.push("### Sources（請保留連結）")
    for (const source of result.sources) {
      lines.push(`- [${source.title}](${source.url}) — ${source.url}`)
    }
    lines.push("")
  }

  if (result.urlsRetrieved.length > 0) {
    lines.push("### URLs Retrieved")
    for (const url of result.urlsRetrieved) {
      const status = url.status === "URL_RETRIEVAL_STATUS_SUCCESS" ? "✓" : "✗"
      lines.push(`- ${status} ${url.url}`)
    }
    lines.push("")
  }

  if (result.searchQueries.length > 0) {
    lines.push("### Search Queries Used")
    for (const q of result.searchQueries) {
      lines.push(`- "${q}"`)
    }
  }

  return lines.join("\n")
}

const MAX_BODY_LOG_CHARS = 12000

function truncateForLog(text: string): string {
  if (text.length <= MAX_BODY_LOG_CHARS) {
    return text
  }
  return `${text.slice(0, MAX_BODY_LOG_CHARS)}... (truncated ${text.length - MAX_BODY_LOG_CHARS} chars)`
}

function logBody(status: number, body: string, context: { headerStyle: HeaderStyle; model: string }): void {
  debugCheckpoint("google_search", "response: body", {
    status,
    headerStyle: context.headerStyle,
    model: context.model,
    length: body.length,
    body: truncateForLog(body),
  })
}

function parseSearchResponse(data: AntigravitySearchResponse): SearchResult {
  const result: SearchResult = {
    text: "",
    sources: [],
    searchQueries: [],
    urlsRetrieved: [],
  }

  const response = data.response
  if (!response || !response.candidates || response.candidates.length === 0) {
    if (data.error) {
      result.text = `Error: ${data.error.message ?? "Unknown error"}`
    } else if (response?.error) {
      result.text = `Error: ${response.error.message ?? "Unknown error"}`
    }
    return result
  }

  const candidate = response.candidates[0]
  if (!candidate) {
    return result
  }

  // Extract text content
  if (candidate.content?.parts) {
    result.text = candidate.content.parts
      .map((p: { text?: string }) => p.text ?? "")
      .filter(Boolean)
      .join("\n")
  }

  // Extract grounding metadata
  if (candidate.groundingMetadata) {
    const gm = candidate.groundingMetadata

    if (gm.webSearchQueries) {
      result.searchQueries = gm.webSearchQueries
    }

    if (gm.groundingChunks) {
      for (const chunk of gm.groundingChunks) {
        if (!chunk.web?.uri) continue
        const title = chunk.web.title ? chunk.web.title : titleFromUrl(chunk.web.uri)
        result.sources.push({
          title,
          url: chunk.web.uri,
        })
      }
    }

    if (!result.text && gm.searchEntryPoint?.renderedContent) {
      const entry = stripHtml(gm.searchEntryPoint.renderedContent)
      if (entry) result.text = entry
    }
  }

  // Extract URL context metadata
  if (candidate.urlContextMetadata?.url_metadata) {
    for (const meta of candidate.urlContextMetadata.url_metadata) {
      if (meta.retrieved_url) {
        result.urlsRetrieved.push({
          url: meta.retrieved_url,
          status: meta.url_retrieval_status ?? "UNKNOWN",
        })
      }
    }
  }

  return result
}

// ============================================================================
// Main Search Function
// ============================================================================

/**
 * Execute a Google Search using the Gemini grounding API.
 *
 * This makes a SEPARATE API call with only googleSearch/urlContext tools,
 * which is required because these tools cannot be combined with function declarations.
 */
export async function executeSearch(
  args: SearchArgs,
  accessToken: string,
  projectId: string,
  abortSignal?: AbortSignal,
  options?: { headerStyle?: HeaderStyle; model?: string },
): Promise<SearchResponseResult> {
  const { query, urls, thinking = true } = args
  const headerStyle = options?.headerStyle ?? "antigravity"
  const requestedModel = options?.model ?? SEARCH_MODEL
  const resolvedModel = resolveModelForHeaderStyle(requestedModel, headerStyle)
  const model = resolvedModel.actualModel

  const useGemini3Thinking = resolvedModel.thinkingLevel && model.toLowerCase().includes("gemini-3")
  const useGemini25Thinking = model.toLowerCase().includes("gemini-2.5")
  const thinkingConfig = useGemini3Thinking
    ? { thinkingLevel: thinking ? resolvedModel.thinkingLevel : "low", includeThoughts: false }
    : useGemini25Thinking
      ? {
          thinkingBudget: thinking ? SEARCH_THINKING_BUDGET_DEEP : SEARCH_THINKING_BUDGET_FAST,
          includeThoughts: false,
        }
      : undefined

  // Build prompt with optional URLs
  let prompt = query
  if (urls && urls.length > 0) {
    const urlList = urls.join("\n")
    prompt = `${query}\n\nURLs to analyze:\n${urlList}`
  }

  // Build tools array - only grounding tools, no function declarations
  const tools: Array<Record<string, unknown>> = []
  tools.push({ googleSearch: {} })
  if (urls && urls.length > 0) {
    tools.push({ urlContext: {} })
  }

  const requestPayload = {
    systemInstruction: {
      parts: [{ text: SEARCH_SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    tools,
    generationConfig: thinkingConfig ? { thinkingConfig } : undefined,
  }

  // Wrap in Antigravity format
  const wrappedBody = {
    project: projectId,
    model,
    userAgent: headerStyle,
    requestId: generateRequestId(),
    request: {
      ...requestPayload,
      sessionId: getSessionId(),
    },
  }

  // Use non-streaming endpoint for search
  const baseEndpoint = headerStyle === "gemini-cli" ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT
  const url = `${baseEndpoint}/v1internal:generateContent`
  const headers: Record<string, string> = {
    ...getRandomizedHeaders(headerStyle),
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  }
  const origin = env.OPENCODE_ANTIGRAVITY_SEARCH_ORIGIN
  if (origin) {
    headers.Origin = origin
  }
  const referer = env.OPENCODE_ANTIGRAVITY_SEARCH_REFERER
  if (referer) {
    headers.Referer = referer
  }

  log.debug("Executing search", {
    query,
    urlCount: urls?.length ?? 0,
    thinking,
    headerStyle,
    model,
  })
  debugCheckpoint("google_search", "request: prepared", {
    headerStyle,
    model,
    urlCount: urls?.length ?? 0,
    thinking,
    origin: origin ? true : false,
    referer: referer ? true : false,
  })

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(wrappedBody),
      signal: abortSignal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errorText = await response.text()
      logBody(response.status, errorText, { headerStyle, model })
      log.debug("Search API error", { status: response.status, error: errorText })
      debugCheckpoint("google_search", "response: error", {
        status: response.status,
        statusText: response.statusText,
      })
      const output = `## Search Error\n\nFailed to execute search: ${response.status} ${response.statusText}\n\n${errorText}\n\nPlease try again with a different query.`
      return {
        ok: false,
        output,
        error: `Search failed: ${response.status} ${response.statusText}`,
        status: response.status,
      }
    }

    const bodyText = await response.text()
    logBody(response.status, bodyText, { headerStyle, model })
    const data = JSON.parse(bodyText) as AntigravitySearchResponse
    log.debug("Search response received", { hasResponse: !!data.response })

    const result = parseSearchResponse(data)
    const empty =
      !result.text.trim() &&
      result.sources.length === 0 &&
      result.searchQueries.length === 0 &&
      result.urlsRetrieved.length === 0
    if (empty) {
      const entry = data.response?.candidates?.[0]?.groundingMetadata?.searchEntryPoint?.renderedContent
      debugCheckpoint("google_search", "response: empty", {
        headerStyle,
        model,
        hasEntry: !!entry,
        entryLength: entry?.length ?? 0,
      })
      const output = "## Search Error\n\nSearch returned empty response. Please try again with a different query."
      return { ok: false, output, error: "Search returned empty response" }
    }
    const formatted = formatSearchResult(result)
    log.debug("Search response formatted", { resultLength: formatted.length })
    debugCheckpoint("google_search", "response: ok", { length: formatted.length })
    return { ok: true, output: formatted }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.debug("Search execution error", { error: message })
    debugCheckpoint("google_search", "response: exception", { error: message })
    const output = `## Search Error\n\nFailed to execute search: ${message}. Please try again with a different query.`
    return { ok: false, output, error: `Search failed: ${message}` }
  }
}
