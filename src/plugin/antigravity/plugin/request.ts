import crypto from "node:crypto"
import {
  ANTIGRAVITY_HEADERS,
  GEMINI_CLI_HEADERS,
  ANTIGRAVITY_ENDPOINT,
  GEMINI_CLI_ENDPOINT,
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
  SKIP_THOUGHT_SIGNATURE,
  getRandomizedHeaders,
  type HeaderStyle,
} from "../constants"
import { cacheSignature, getCachedSignature } from "./cache"
import { getKeepThinking } from "./config"
import { createStreamingTransformer, transformSseLine, transformStreamingPayload } from "./core/streaming"
import { defaultSignatureStore } from "./stores/signature-store"
import {
  DEBUG_MESSAGE_PREFIX,
  isDebugEnabled,
  logAntigravityDebugResponse,
  type AntigravityDebugContext,
} from "./debug"
import { createLogger } from "./logger"
import {
  cleanJSONSchemaForAntigravity,
  DEFAULT_THINKING_BUDGET,
  deepFilterThinkingBlocks,
  extractThinkingConfig,
  extractVariantThinkingConfig,
  extractUsageFromSsePayload,
  extractUsageMetadata,
  fixToolResponseGrouping,
  validateAndFixClaudeToolPairing,
  applyToolPairingFixes,
  injectParameterSignatures,
  injectToolHardeningInstruction,
  isThinkingCapableModel,
  normalizeThinkingConfig,
  parseAntigravityApiBody,
  resolveThinkingConfig,
  rewriteAntigravityPreviewAccessError,
  transformThinkingParts,
  type AntigravityApiBody,
} from "./request-helpers"
import { CLAUDE_TOOL_SYSTEM_INSTRUCTION, CLAUDE_DESCRIPTION_PROMPT, ANTIGRAVITY_SYSTEM_INSTRUCTION } from "../constants"
import { analyzeConversationState, closeToolLoopForThinking, needsThinkingRecovery } from "./thinking-recovery"
import { sanitizeCrossModelPayloadInPlace } from "./transform/cross-model-sanitizer"
import { isClaudeModel, isClaudeThinkingModel, applyClaudeTransforms } from "./transform"
import {
  isGeminiModel,
  isGemini3Model,
  isImageGenerationModel,
  buildImageGenerationConfig,
  applyGeminiTransforms,
} from "./transform"
import {
  resolveModelWithTier,
  resolveModelWithVariant,
  resolveModelForHeaderStyle,
  CLAUDE_THINKING_MAX_OUTPUT_TOKENS,
  type ThinkingTier,
} from "./transform"
import { detectErrorType } from "./recovery"
import { getSessionFingerprint, buildFingerprintHeaders, type Fingerprint } from "./fingerprint"
import type { GoogleSearchConfig } from "./transform/types"

const log = createLogger("request")

import { debugCheckpoint } from "../../../util/debug"

const debug = (msg: string, data?: any) => {
  debugCheckpoint("antigravity", msg, data)
}

const PLUGIN_SESSION_ID = `-${crypto.randomUUID()}`

const sessionDisplayedThinkingHashes = new Set<string>()

const MIN_SIGNATURE_LENGTH = 50

function buildSignatureSessionKey(
  sessionId: string,
  model?: string,
  conversationKey?: string,
  projectKey?: string,
): string {
  const modelKey = typeof model === "string" && model.trim() ? model.toLowerCase() : "unknown"
  const projectPart = typeof projectKey === "string" && projectKey.trim() ? projectKey.trim() : "default"
  const conversationPart =
    typeof conversationKey === "string" && conversationKey.trim() ? conversationKey.trim() : "default"
  return `${sessionId}:${modelKey}:${projectPart}:${conversationPart}`
}

function shouldCacheThinkingSignatures(model?: string): boolean {
  if (typeof model !== "string") return false
  const lower = model.toLowerCase()
  // Both Claude and Gemini 3 models require thought signature caching
  // for multi-turn conversations with function calling
  return lower.includes("claude") || lower.includes("gemini-3")
}

function hashConversationSeed(seed: string): string {
  return crypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16)
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return ""
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue
    }
    const anyBlock = block as any
    if (typeof anyBlock.text === "string") {
      return anyBlock.text
    }
    if (anyBlock.text && typeof anyBlock.text === "object" && typeof anyBlock.text.text === "string") {
      return anyBlock.text.text
    }
  }
  return ""
}

function extractConversationSeedFromMessages(messages: any[]): string {
  const system = messages.find((message) => message?.role === "system")
  const users = messages.filter((message) => message?.role === "user")
  const firstUser = users[0]
  const lastUser = users.length > 0 ? users[users.length - 1] : undefined
  const systemText = system ? extractTextFromContent(system.content) : ""
  const userText = firstUser ? extractTextFromContent(firstUser.content) : ""
  const fallbackUserText = !userText && lastUser ? extractTextFromContent(lastUser.content) : ""
  return [systemText, userText || fallbackUserText].filter(Boolean).join("|")
}

function extractConversationSeedFromContents(contents: any[]): string {
  const users = contents.filter((content) => content?.role === "user")
  const firstUser = users[0]
  const lastUser = users.length > 0 ? users[users.length - 1] : undefined
  const primaryUser = firstUser && Array.isArray(firstUser.parts) ? extractTextFromContent(firstUser.parts) : ""
  if (primaryUser) {
    return primaryUser
  }
  if (lastUser && Array.isArray(lastUser.parts)) {
    return extractTextFromContent(lastUser.parts)
  }
  return ""
}

function resolveConversationKey(requestPayload: Record<string, unknown>): string | undefined {
  const anyPayload = requestPayload as any
  const candidates = [
    anyPayload.conversationId,
    anyPayload.conversation_id,
    anyPayload.thread_id,
    anyPayload.threadId,
    anyPayload.chat_id,
    anyPayload.chatId,
    anyPayload.sessionId,
    anyPayload.session_id,
    anyPayload.metadata?.conversation_id,
    anyPayload.metadata?.conversationId,
    anyPayload.metadata?.thread_id,
    anyPayload.metadata?.threadId,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim()
    }
  }

  const systemSeed = extractTextFromContent(
    (anyPayload.systemInstruction as any)?.parts ??
      anyPayload.systemInstruction ??
      anyPayload.system ??
      anyPayload.system_instruction,
  )
  const messageSeed = Array.isArray(anyPayload.messages)
    ? extractConversationSeedFromMessages(anyPayload.messages)
    : Array.isArray(anyPayload.contents)
      ? extractConversationSeedFromContents(anyPayload.contents)
      : ""
  const seed = [systemSeed, messageSeed].filter(Boolean).join("|")
  if (!seed) {
    return undefined
  }
  return `seed-${hashConversationSeed(seed)}`
}

function resolveConversationKeyFromRequests(requestObjects: Array<Record<string, unknown>>): string | undefined {
  for (const req of requestObjects) {
    const key = resolveConversationKey(req)
    if (key) {
      return key
    }
  }
  return undefined
}

function resolveProjectKey(candidate?: unknown, fallback?: string): string | undefined {
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim()
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim()
  }
  return undefined
}

function formatDebugLinesForThinking(lines: string[]): string {
  const cleaned = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-50)
  return `${DEBUG_MESSAGE_PREFIX}\n${cleaned.map((line) => `- ${line}`).join("\n")}`
}

function injectDebugThinking(response: unknown, debugText: string): unknown {
  if (!response || typeof response !== "object") {
    return response
  }

  const resp = response as any

  if (Array.isArray(resp.candidates) && resp.candidates.length > 0) {
    const candidates = resp.candidates.slice()
    const first = candidates[0]

    if (
      first &&
      typeof first === "object" &&
      first.content &&
      typeof first.content === "object" &&
      Array.isArray(first.content.parts)
    ) {
      const parts = [{ thought: true, text: debugText }, ...first.content.parts]
      candidates[0] = { ...first, content: { ...first.content, parts } }
      return { ...resp, candidates }
    }

    return resp
  }

  if (Array.isArray(resp.content)) {
    const content = [{ type: "thinking", thinking: debugText }, ...resp.content]
    return { ...resp, content }
  }

  if (!resp.reasoning_content) {
    return { ...resp, reasoning_content: debugText }
  }

  return resp
}

const SYNTHETIC_THINKING_PLACEHOLDER = "[Thinking preserved]\n"

function stripInjectedDebugFromParts(parts: unknown): unknown {
  if (!Array.isArray(parts)) {
    return parts
  }

  return parts.filter((part) => {
    if (!part || typeof part !== "object") {
      return true
    }

    const record = part as any
    const text =
      typeof record.text === "string" ? record.text : typeof record.thinking === "string" ? record.thinking : undefined

    // Strip debug blocks and synthetic thinking placeholders
    if (text && (text.startsWith(DEBUG_MESSAGE_PREFIX) || text.startsWith(SYNTHETIC_THINKING_PLACEHOLDER.trim()))) {
      return false
    }

    return true
  })
}

function stripInjectedDebugFromRequestPayload(payload: Record<string, unknown>): void {
  const anyPayload = payload as any

  if (Array.isArray(anyPayload.contents)) {
    anyPayload.contents = anyPayload.contents.map((content: any) => {
      if (!content || typeof content !== "object") {
        return content
      }

      if (Array.isArray(content.parts)) {
        return { ...content, parts: stripInjectedDebugFromParts(content.parts) }
      }

      if (Array.isArray(content.content)) {
        return { ...content, content: stripInjectedDebugFromParts(content.content) }
      }

      return content
    })
  }

  if (Array.isArray(anyPayload.messages)) {
    anyPayload.messages = anyPayload.messages.map((message: any) => {
      if (!message || typeof message !== "object") {
        return message
      }

      if (Array.isArray(message.content)) {
        return { ...message, content: stripInjectedDebugFromParts(message.content) }
      }

      return message
    })
  }
}

function isGeminiToolUsePart(part: any): boolean {
  return !!(part && typeof part === "object" && (part.functionCall || part.tool_use || part.toolUse))
}

function isGeminiThinkingPart(part: any): boolean {
  return !!(
    part &&
    typeof part === "object" &&
    (part.thought === true || part.type === "thinking" || part.type === "reasoning")
  )
}

const SKIP_THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator"

function ensureThoughtSignature(part: any, sessionId: string, allowSentinel: boolean = true): any {
  if (!part || typeof part !== "object") {
    return part
  }

  const text = typeof part.text === "string" ? part.text : typeof part.thinking === "string" ? part.thinking : ""
  if (!text) {
    return part
  }

  if (part.thought === true) {
    if (!part.thoughtSignature) {
      const cached = getCachedSignature(sessionId, text)
      if (cached) {
        return { ...part, thoughtSignature: cached }
      }
      return allowSentinel ? { ...part, thoughtSignature: SKIP_THOUGHT_SIGNATURE_SENTINEL } : part
    }
    return part
  }

  if ((part.type === "thinking" || part.type === "reasoning") && !part.signature) {
    const cached = getCachedSignature(sessionId, text)
    if (cached) {
      return { ...part, signature: cached }
    }
    return allowSentinel ? { ...part, signature: SKIP_THOUGHT_SIGNATURE_SENTINEL } : part
  }

  return part
}

function hasSignedThinkingPart(part: any): boolean {
  if (!part || typeof part !== "object") {
    return false
  }

  if (part.thought === true) {
    return typeof part.thoughtSignature === "string" && part.thoughtSignature.length >= MIN_SIGNATURE_LENGTH
  }

  if (part.type === "thinking" || part.type === "reasoning") {
    return typeof part.signature === "string" && part.signature.length >= MIN_SIGNATURE_LENGTH
  }

  return false
}

function ensureThinkingBeforeToolUseInContents(
  contents: any[],
  signatureSessionKey: string,
  options?: { allowSentinel?: boolean },
): any[] {
  const allowSentinel = options?.allowSentinel !== false
  debug("ensureThinkingBeforeToolUseInContents called", {
    contentCount: contents?.length,
    signatureSessionKey,
    allowSentinel,
  })

  return contents.map((content: any, idx: number) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return content
    }

    const role = content.role
    if (role !== "model" && role !== "assistant") {
      return content
    }

    const parts = content.parts as any[]
    const hasToolUse = parts.some(isGeminiToolUsePart)
    if (!hasToolUse) {
      return content
    }

    debug(`Content[${idx}] has tool use, processing`, {
      role,
      partCount: parts.length,
    })

    const thinkingParts = parts
      .filter(isGeminiThinkingPart)
      .map((p) => ensureThoughtSignature(p, signatureSessionKey, allowSentinel))
      // For providers/models where sentinel is not supported (e.g. Claude on Antigravity),
      // never pass through unsigned thinking blocks.
      .filter((p) => (allowSentinel ? true : hasSignedThinkingPart(p)))
    const otherParts = parts
      .filter((p) => !isGeminiThinkingPart(p))
      .map((p, partIdx) => {
        if (p && typeof p === "object" && p.functionCall) {
          debug(`Processing functionCall in contents[${idx}].parts[${partIdx}]`, {
            hasSignature: !!p.thoughtSignature,
            signatureLength: p.thoughtSignature?.length,
            functionName: p.functionCall.name,
          })
        }
        if (allowSentinel && p && typeof p === "object" && p.functionCall && !p.thoughtSignature) {
          debug(`Injecting sentinel signature into functionCall contents[${idx}].parts[${partIdx}]`, {
            functionName: p.functionCall.name,
          })
          return { ...p, thoughtSignature: SKIP_THOUGHT_SIGNATURE_SENTINEL }
        }
        return p
      })
    const hasSignedThinking = thinkingParts.some(hasSignedThinkingPart)

    if (hasSignedThinking) {
      return { ...content, parts: [...thinkingParts, ...otherParts] }
    }

    const lastThinking = defaultSignatureStore.get(signatureSessionKey)
    if (!lastThinking) {
      // For models that support sentinel (Gemini), we can preserve existing thinking parts
      // and inject sentinel thinking blocks on cache miss.
      if (allowSentinel) {
        // If we have an existing thinking part (which ensureThoughtSignature likely marked with sentinel), use it.
        if (thinkingParts.length > 0) {
          log.debug("Using sentinel signature for existing thinking (cache miss)", { signatureSessionKey })
          return { ...content, parts: [...thinkingParts, ...otherParts] }
        }

        // Otherwise, inject a new sentinel thinking block
        log.debug("Injecting sentinel signature (cache miss)", { signatureSessionKey })
        const injected = {
          thought: true,
          text: "Thinking Process",
          thoughtSignature: SKIP_THOUGHT_SIGNATURE_SENTINEL,
        }
        return { ...content, parts: [injected, ...otherParts] }
      }

      // Sentinel is not supported (e.g. Claude). Never inject fake signatures.
      // Just drop thinking blocks and continue with tool use parts.
      return { ...content, parts: otherParts }
    }

    const injected = {
      thought: true,
      text: lastThinking.text,
      thoughtSignature: lastThinking.signature,
    }

    return { ...content, parts: [injected, ...otherParts] }
  })
}

function ensureMessageThinkingSignature(block: any, sessionId: string): any {
  if (!block || typeof block !== "object") {
    return block
  }

  if (block.type !== "thinking" && block.type !== "redacted_thinking") {
    return block
  }

  if (typeof block.signature === "string" && block.signature.length >= MIN_SIGNATURE_LENGTH) {
    return block
  }

  const text = typeof block.thinking === "string" ? block.thinking : typeof block.text === "string" ? block.text : ""
  if (!text) {
    return block
  }

  const cached = getCachedSignature(sessionId, text)
  if (cached) {
    return { ...block, signature: cached }
  }

  return block
}

function hasToolUseInContents(contents: any[]): boolean {
  return contents.some((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false
    }
    return (content.parts as any[]).some(isGeminiToolUsePart)
  })
}

function hasSignedThinkingInContents(contents: any[]): boolean {
  return contents.some((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false
    }
    return (content.parts as any[]).some(hasSignedThinkingPart)
  })
}

function hasToolUseInMessages(messages: any[]): boolean {
  return messages.some((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return false
    }
    return (message.content as any[]).some(
      (block) => block && typeof block === "object" && (block.type === "tool_use" || block.type === "tool_result"),
    )
  })
}

function hasSignedThinkingInMessages(messages: any[]): boolean {
  return messages.some((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return false
    }
    return (message.content as any[]).some(
      (block) =>
        block &&
        typeof block === "object" &&
        (block.type === "thinking" || block.type === "redacted_thinking") &&
        typeof block.signature === "string" &&
        block.signature.length >= MIN_SIGNATURE_LENGTH,
    )
  })
}

function ensureThinkingBeforeToolUseInMessages(
  messages: any[],
  signatureSessionKey: string,
  options?: { allowSentinel?: boolean },
): any[] {
  const allowSentinel = options?.allowSentinel !== false
  return messages.map((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return message
    }

    if (message.role !== "assistant") {
      return message
    }

    const blocks = message.content as any[]
    const hasToolUse = blocks.some(
      (b) => b && typeof b === "object" && (b.type === "tool_use" || b.type === "tool_result"),
    )
    if (!hasToolUse) {
      return message
    }

    const thinkingBlocks = blocks
      .filter((b) => b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking"))
      .map((b) => ensureMessageThinkingSignature(b, signatureSessionKey))

    const otherBlocks = blocks
      .filter((b) => !(b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking")))
      .map((b) => {
        if (allowSentinel && b && typeof b === "object" && b.functionCall && !b.thoughtSignature) {
          return { ...b, thoughtSignature: SKIP_THOUGHT_SIGNATURE_SENTINEL }
        }
        return b
      })
    const hasSignedThinking = thinkingBlocks.some(
      (b) => typeof b.signature === "string" && b.signature.length >= MIN_SIGNATURE_LENGTH,
    )

    if (hasSignedThinking) {
      return { ...message, content: [...thinkingBlocks, ...otherBlocks] }
    }

    const lastThinking = defaultSignatureStore.get(signatureSessionKey)
    if (!lastThinking) {
      const existingThinking = thinkingBlocks[0]
      const thinkingText = existingThinking?.thinking || existingThinking?.text || ""
      if (allowSentinel) {
        log.debug("Injecting sentinel signature (cache miss)", { signatureSessionKey })
        const sentinelBlock = {
          type: "thinking",
          thinking: thinkingText,
          signature: SKIP_THOUGHT_SIGNATURE,
        }
        return { ...message, content: [sentinelBlock, ...otherBlocks] }
      }

      // Sentinel is not supported (e.g. Claude). Never inject fake signatures.
      return { ...message, content: otherBlocks }
    }

    const injected = {
      type: "thinking",
      thinking: lastThinking.text,
      signature: lastThinking.signature,
    }

    return { ...message, content: [injected, ...otherBlocks] }
  })
}

export function getPluginSessionId(): string {
  return PLUGIN_SESSION_ID
}

function generateSyntheticProjectId(): string {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"]
  const nouns = ["fuze", "wave", "spark", "flow", "core"]
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
  const noun = nouns[Math.floor(Math.random() * nouns.length)]
  const randomPart = crypto.randomUUID().slice(0, 5).toLowerCase()
  return `${adj}-${noun}-${randomPart}`
}

const STREAM_ACTION = "streamGenerateContent"

export function isGenerativeLanguageRequest(input: RequestInfo): boolean {
  const url = typeof input === "string" ? input : (input as any).url
  return typeof url === "string" && url.includes("generativelanguage.googleapis.com")
}

export interface PrepareRequestOptions {
  claudeToolHardening?: boolean
  googleSearch?: GoogleSearchConfig
  fingerprint?: Fingerprint
  forceDisableThinking?: boolean
}

export function prepareAntigravityRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
  endpointOverride?: string,
  headerStyle: HeaderStyle = "antigravity",
  forceThinkingRecovery = false,
  options?: PrepareRequestOptions,
): {
  request: RequestInfo
  init: RequestInit
  streaming: boolean
  requestedModel?: string
  effectiveModel?: string
  projectId?: string
  endpoint?: string
  sessionId?: string
  toolDebugMissing?: number
  toolDebugSummary?: string
  toolDebugPayload?: string
  needsSignedThinkingWarmup?: boolean
  headerStyle: HeaderStyle
  thinkingRecoveryMessage?: string
} {
  const inputUrl = typeof input === "string" ? input : (input as any)?.url || String(input)
  debug("prepareAntigravityRequest called", {
    url: inputUrl,
    headerStyle,
    forceThinkingRecovery,
    hasBody: !!init?.body,
  })

  const baseInit: RequestInit = { ...init }
  const headers = new Headers(init?.headers ?? {})
  let resolvedProjectId = projectId?.trim() || ""
  let toolDebugMissing = 0
  const toolDebugSummaries: string[] = []
  let toolDebugPayload: string | undefined
  let sessionId: string | undefined
  let needsSignedThinkingWarmup = false
  let thinkingRecoveryMessage: string | undefined

  if (!isGenerativeLanguageRequest(input)) {
    debug("Not a generativelanguage request, skipping", { url: inputUrl })
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle,
    }
  }

  headers.set("Authorization", `Bearer ${accessToken}`)
  headers.delete("x-api-key")

  const urlString = typeof input === "string" ? input : (input as any).url
  const match = urlString.match(/\/models\/([^:]+):(\w+)/)
  if (!match) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle,
    }
  }

  const [, rawModel = "", rawAction = ""] = match
  const requestedModel = rawModel

  const resolved = resolveModelForHeaderStyle(rawModel, headerStyle)
  const effectiveModel = resolved.actualModel

  const streaming = rawAction === STREAM_ACTION
  const defaultEndpoint = headerStyle === "gemini-cli" ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT
  const baseEndpoint = endpointOverride ?? defaultEndpoint
  const transformedUrl = `${baseEndpoint}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`

  const isClaude = isClaudeModel(resolved.actualModel)
  const isClaudeThinking = isClaudeThinkingModel(resolved.actualModel)

  let tierThinkingBudget = resolved.thinkingBudget
  let tierThinkingLevel = resolved.thinkingLevel

  if (options?.forceDisableThinking) {
    tierThinkingBudget = undefined
    tierThinkingLevel = undefined
  }
  let signatureSessionKey = buildSignatureSessionKey(
    PLUGIN_SESSION_ID,
    effectiveModel,
    undefined,
    resolveProjectKey(projectId),
  )

  let body = baseInit.body
  if (typeof baseInit.body === "string" && baseInit.body) {
    try {
      const parsedBody = JSON.parse(baseInit.body) as Record<string, unknown>
      const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody

      if (isWrapped) {
        const wrappedBody = {
          ...parsedBody,
          model: effectiveModel,
        } as Record<string, unknown>

        const requestRoot = wrappedBody.request
        const requestObjects: Array<Record<string, unknown>> = []

        if (requestRoot && typeof requestRoot === "object") {
          requestObjects.push(requestRoot as Record<string, unknown>)
          const nested = (requestRoot as any).request
          if (nested && typeof nested === "object") {
            requestObjects.push(nested as Record<string, unknown>)
          }
        }

        const conversationKey = resolveConversationKeyFromRequests(requestObjects)
        const modelForCacheKey = effectiveModel.replace(/-(minimal|low|medium|high)$/i, "")
        signatureSessionKey = buildSignatureSessionKey(
          PLUGIN_SESSION_ID,
          modelForCacheKey,
          conversationKey,
          resolveProjectKey(parsedBody.project),
        )

        if (requestObjects.length > 0) {
          sessionId = signatureSessionKey
        }

        for (const req of requestObjects) {
          ;(req as any).sessionId = signatureSessionKey
          stripInjectedDebugFromRequestPayload(req as Record<string, unknown>)

          if (isClaude) {
            sanitizeCrossModelPayloadInPlace(req, { targetModel: effectiveModel })
            deepFilterThinkingBlocks(req, signatureSessionKey, getCachedSignature, true)
            if (isClaudeThinking && Array.isArray((req as any).contents)) {
              // Claude thinking signatures must be preserved exactly; sentinel is not supported.
              ;(req as any).contents = ensureThinkingBeforeToolUseInContents(
                (req as any).contents,
                signatureSessionKey,
                {
                  allowSentinel: false,
                },
              )
            }
            if (isClaudeThinking && Array.isArray((req as any).messages)) {
              // Claude thinking signatures must be preserved exactly; sentinel is not supported.
              ;(req as any).messages = ensureThinkingBeforeToolUseInMessages(
                (req as any).messages,
                signatureSessionKey,
                {
                  allowSentinel: false,
                },
              )
            }
            applyToolPairingFixes(req as Record<string, unknown>, true)
          } else if (isGemini3Model(effectiveModel)) {
            // EXPERIMENTAL: Apply thinking signature enforcement for Gemini 3 models
            deepFilterThinkingBlocks(req, signatureSessionKey, getCachedSignature, true)
            if (Array.isArray((req as any).contents)) {
              ;(req as any).contents = ensureThinkingBeforeToolUseInContents(
                (req as any).contents,
                signatureSessionKey,
                {
                  allowSentinel: true,
                },
              )
            }
            if (Array.isArray((req as any).messages)) {
              ;(req as any).messages = ensureThinkingBeforeToolUseInMessages(
                (req as any).messages,
                signatureSessionKey,
                {
                  allowSentinel: true,
                },
              )
            }
          }
        }

        if ((isClaudeThinking || isGemini3Model(effectiveModel)) && sessionId) {
          const hasToolUse = requestObjects.some(
            (req) =>
              (Array.isArray((req as any).contents) && hasToolUseInContents((req as any).contents)) ||
              (Array.isArray((req as any).messages) && hasToolUseInMessages((req as any).messages)),
          )
          const hasSignedThinking = requestObjects.some(
            (req) =>
              (Array.isArray((req as any).contents) && hasSignedThinkingInContents((req as any).contents)) ||
              (Array.isArray((req as any).messages) && hasSignedThinkingInMessages((req as any).messages)),
          )
          const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey)
          needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking
        }

        body = JSON.stringify(wrappedBody)
      } else {
        const requestPayload: Record<string, unknown> = { ...parsedBody }

        const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined
        const extraBody = requestPayload.extra_body as Record<string, unknown> | undefined

        const variantConfig = extractVariantThinkingConfig(
          requestPayload.providerOptions as Record<string, unknown> | undefined,
        )
        const isGemini3 = effectiveModel.toLowerCase().includes("gemini-3")

        if (variantConfig?.thinkingLevel && isGemini3) {
          tierThinkingLevel = variantConfig.thinkingLevel
          tierThinkingBudget = undefined
        } else if (variantConfig?.thinkingBudget) {
          if (isGemini3) {
            log.warn("[Deprecated] Using thinkingBudget for Gemini 3 model. Use thinkingLevel instead.")
            tierThinkingLevel =
              variantConfig.thinkingBudget <= 8192 ? "low" : variantConfig.thinkingBudget <= 16384 ? "medium" : "high"
            tierThinkingBudget = undefined
          } else {
            tierThinkingBudget = variantConfig.thinkingBudget
            tierThinkingLevel = undefined
          }
        }

        const convoKey = resolveConversationKey(requestPayload)
        const modelForCacheKey = effectiveModel.replace(/-(minimal|low|medium|high)$/i, "")
        signatureSessionKey = buildSignatureSessionKey(
          PLUGIN_SESSION_ID,
          modelForCacheKey,
          convoKey,
          resolveProjectKey(projectId),
        )
        sessionId = signatureSessionKey

        if (isClaude) {
          applyClaudeTransforms(requestPayload, {
            model: effectiveModel,
            tierThinkingBudget,
            normalizedThinking: extractThinkingConfig(requestPayload, rawGenerationConfig, extraBody),
            cleanJSONSchema: cleanJSONSchemaForAntigravity,
          })

          if (
            Array.isArray(requestPayload.tools) &&
            (requestPayload.tools as any[]).length > 0 &&
            options?.claudeToolHardening !== false
          ) {
            injectParameterSignatures(requestPayload.tools as any[])
            injectToolHardeningInstruction(requestPayload, CLAUDE_TOOL_SYSTEM_INSTRUCTION)
          }

          sanitizeCrossModelPayloadInPlace(requestPayload, { targetModel: effectiveModel })
          deepFilterThinkingBlocks(requestPayload, signatureSessionKey, getCachedSignature, true)
          if (isClaudeThinking && Array.isArray((requestPayload as any).contents)) {
            ;(requestPayload as any).contents = ensureThinkingBeforeToolUseInContents(
              (requestPayload as any).contents,
              signatureSessionKey,
              { allowSentinel: false },
            )
          }
          if (isClaudeThinking && Array.isArray((requestPayload as any).messages)) {
            ;(requestPayload as any).messages = ensureThinkingBeforeToolUseInMessages(
              (requestPayload as any).messages,
              signatureSessionKey,
              { allowSentinel: false },
            )
          }
          applyToolPairingFixes(requestPayload, true)
        } else if (isGemini3) {
          // EXPERIMENTAL: Apply thinking signature enforcement for Gemini 3 models
          deepFilterThinkingBlocks(requestPayload, signatureSessionKey, getCachedSignature, true)
          if (Array.isArray((requestPayload as any).contents)) {
            ;(requestPayload as any).contents = ensureThinkingBeforeToolUseInContents(
              (requestPayload as any).contents,
              signatureSessionKey,
              { allowSentinel: true },
            )
          }
          if (Array.isArray((requestPayload as any).messages)) {
            ;(requestPayload as any).messages = ensureThinkingBeforeToolUseInMessages(
              (requestPayload as any).messages,
              signatureSessionKey,
              { allowSentinel: true },
            )
          }
        }

        if (isClaudeThinking || isGemini3) {
          const hasToolUse =
            (Array.isArray(requestPayload.contents) && hasToolUseInContents(requestPayload.contents)) ||
            (Array.isArray(requestPayload.messages) && hasToolUseInMessages(requestPayload.messages))
          const hasSignedThinking =
            (Array.isArray(requestPayload.contents) && hasSignedThinkingInContents(requestPayload.contents)) ||
            (Array.isArray(requestPayload.messages) && hasSignedThinkingInMessages(requestPayload.messages))
          const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey)
          needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking
        }

        if (forceThinkingRecovery) {
          const contents = (requestPayload.contents || requestPayload.messages) as any[]
          const state = analyzeConversationState(contents)
          if (needsThinkingRecovery(state)) {
            const recoveryContents = closeToolLoopForThinking(contents)
            if (requestPayload.contents) {
              requestPayload.contents = recoveryContents
            } else {
              requestPayload.messages = recoveryContents
            }
            thinkingRecoveryMessage = "Thinking recovery applied: turn completed and new turn started."
          }
        }

        const normalizedThinking = extractThinkingConfig(requestPayload, rawGenerationConfig, extraBody)
        const hasAssistantHistory = (((requestPayload.contents || requestPayload.messages) as any[]) || []).some(
          (c: any) => c.role === "model" || c.role === "assistant",
        )

        const generationConfig = (rawGenerationConfig ?? {}) as Record<string, unknown>
        if (isClaudeThinking || (isThinkingCapableModel(effectiveModel) && (tierThinkingBudget || tierThinkingLevel))) {
          generationConfig.thinkingConfig = resolveThinkingConfig(
            normalizedThinking,
            true, // isThinkingModel
            isClaudeThinking,
            hasAssistantHistory,
          )

          if (isClaudeThinking && !generationConfig.maxOutputTokens) {
            generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS
          }
        }

        if (isImageGenerationModel(effectiveModel)) {
          requestPayload.generationConfig = buildImageGenerationConfig()
        } else {
          requestPayload.generationConfig = generationConfig
        }

        if (isGeminiModel(effectiveModel)) {
          applyGeminiTransforms(requestPayload, {
            model: effectiveModel,
            tierThinkingBudget,
            tierThinkingLevel: tierThinkingLevel as ThinkingTier | undefined,
            // Apply thinking config only if:
            // 1. Not forcibly disabled by retry logic (forceDisableThinking)
            // 2. Model is capable OR user explicitly requested it via tier config
            normalizedThinking:
              !options?.forceDisableThinking &&
              (isThinkingCapableModel(effectiveModel) || tierThinkingBudget || tierThinkingLevel)
                ? normalizedThinking
                : undefined,
            googleSearch: options?.googleSearch,
          })
        }

        if (isClaudeThinking && !getKeepThinking()) {
          defaultSignatureStore.delete(signatureSessionKey)
        }

        if ("model" in requestPayload) {
          delete requestPayload.model
        }

        stripInjectedDebugFromRequestPayload(requestPayload)

        const effectiveProjectId = projectId?.trim() || generateSyntheticProjectId()
        resolvedProjectId = effectiveProjectId

        if (headerStyle === "antigravity") {
          const existingSystemInstruction = requestPayload.systemInstruction
          if (existingSystemInstruction && typeof existingSystemInstruction === "object") {
            const sys = existingSystemInstruction as Record<string, unknown>
            sys.role = "user"
            if (Array.isArray(sys.parts) && sys.parts.length > 0) {
              const firstPart = sys.parts[0] as Record<string, unknown>
              if (firstPart && typeof firstPart.text === "string") {
                firstPart.text = ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + firstPart.text
              } else {
                sys.parts = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...sys.parts]
              }
            } else {
              sys.parts = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }]
            }
          } else if (typeof existingSystemInstruction === "string") {
            requestPayload.systemInstruction = {
              role: "user",
              parts: [
                {
                  text: ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + existingSystemInstruction,
                },
              ],
            }
          } else {
            requestPayload.systemInstruction = {
              role: "user",
              parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }],
            }
          }
        }

        const wrappedBody = {
          project: effectiveProjectId,
          model: effectiveModel,
          request: requestPayload,
          requestType: "agent",
        }

        Object.assign(wrappedBody, {
          userAgent: "antigravity",
          requestId: "agent-" + crypto.randomUUID(),
        })
        if (wrappedBody.request && typeof wrappedBody.request === "object") {
          sessionId = signatureSessionKey
          ;(wrappedBody.request as any).sessionId = signatureSessionKey
        }

        body = JSON.stringify(wrappedBody)
      }
    } catch (error) {
      throw error
    }
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream")
  }

  if (isClaudeThinking) {
    const existing = headers.get("anthropic-beta")
    const interleavedHeader = "interleaved-thinking-2025-05-14"

    if (existing) {
      if (!existing.includes(interleavedHeader)) {
        headers.set("anthropic-beta", `${existing},${interleavedHeader}`)
      }
    } else {
      headers.set("anthropic-beta", interleavedHeader)
    }
  }

  const selectedHeaders = getRandomizedHeaders(headerStyle)
  const fingerprint = options?.fingerprint ?? getSessionFingerprint()
  const fingerprintHeaders = buildFingerprintHeaders(fingerprint)

  headers.set("User-Agent", fingerprintHeaders["User-Agent"] || selectedHeaders["User-Agent"])
  headers.set("X-Goog-Api-Client", fingerprintHeaders["X-Goog-Api-Client"] || selectedHeaders["X-Goog-Api-Client"])
  headers.set("Client-Metadata", fingerprintHeaders["Client-Metadata"] || selectedHeaders["Client-Metadata"])

  if (fingerprintHeaders["X-Goog-QuotaUser"]) {
    headers.set("X-Goog-QuotaUser", fingerprintHeaders["X-Goog-QuotaUser"])
  }
  if (fingerprintHeaders["X-Client-Device-Id"]) {
    headers.set("X-Client-Device-Id", fingerprintHeaders["X-Client-Device-Id"])
  }
  if (toolDebugMissing > 0) {
    headers.set("X-Opencode-Tools-Debug", String(toolDebugMissing))
  }

  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel,
    effectiveModel: effectiveModel,
    projectId: resolvedProjectId,
    endpoint: transformedUrl,
    sessionId,
    toolDebugMissing,
    toolDebugSummary: toolDebugSummaries.slice(0, 20).join(" | "),
    toolDebugPayload,
    needsSignedThinkingWarmup,
    headerStyle,
    thinkingRecoveryMessage,
  }
}

export function buildThinkingWarmupBody(bodyText: string | undefined, isClaudeThinking: boolean): string | null {
  if (!bodyText || !isClaudeThinking) {
    return null
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return null
  }

  const warmupPrompt = "Warmup request for thinking signature."

  const updateRequest = (req: Record<string, unknown>) => {
    req.contents = [
      {
        role: "user",
        parts: [{ text: warmupPrompt }],
      },
    ]
    delete req.tools
    delete (req as any).toolConfig

    const generationConfig = (req.generationConfig ?? {}) as Record<string, unknown>
    generationConfig.thinkingConfig = {
      include_thoughts: true,
      thinking_budget: DEFAULT_THINKING_BUDGET,
    }
    generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS
    req.generationConfig = generationConfig
  }

  if (parsed.request && typeof parsed.request === "object") {
    updateRequest(parsed.request as Record<string, unknown>)
    const nested = (parsed.request as any).request
    if (nested && typeof nested === "object") {
      updateRequest(nested as Record<string, unknown>)
    }
  } else {
    updateRequest(parsed)
  }

  return JSON.stringify(parsed)
}

export async function transformAntigravityResponse(
  response: Response,
  streaming: boolean,
  debugContext?: AntigravityDebugContext | null,
  requestedModel?: string,
  projectId?: string,
  endpoint?: string,
  effectiveModel?: string,
  sessionId?: string,
  toolDebugMissing?: number,
  toolDebugSummary?: string,
  toolDebugPayload?: string,
  debugLines?: string[],
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? ""
  const isJsonResponse = contentType.includes("application/json")
  const isEventStreamResponse = contentType.includes("text/event-stream")

  const debugText =
    isDebugEnabled() && Array.isArray(debugLines) && debugLines.length > 0
      ? formatDebugLinesForThinking(debugLines)
      : getKeepThinking()
        ? SYNTHETIC_THINKING_PLACEHOLDER
        : undefined
  const cacheSignatures = shouldCacheThinkingSignatures(effectiveModel)

  if (!isJsonResponse && !isEventStreamResponse) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    })
    return response
  }

  if (streaming && response.ok && isEventStreamResponse && response.body) {
    const headers = new Headers(response.headers)

    logAntigravityDebugResponse(debugContext, response, {
      note: "Streaming SSE response (real-time transform)",
    })

    const streamingTransformer = createStreamingTransformer(
      defaultSignatureStore,
      {
        onCacheSignature: cacheSignature,
        onInjectDebug: injectDebugThinking,
        transformThinkingParts,
      },
      {
        signatureSessionKey: sessionId,
        debugText,
        cacheSignatures,
        displayedThinkingHashes:
          effectiveModel && isGemini3Model(effectiveModel) ? sessionDisplayedThinkingHashes : undefined,
      },
    )
    return new Response(response.body.pipeThrough(streamingTransformer), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  try {
    const headers = new Headers(response.headers)
    const text = await response.text()

    if (!response.ok) {
      let errorBody
      try {
        errorBody = JSON.parse(text)
      } catch {
        errorBody = { error: { message: text } }
      }

      if (errorBody?.error) {
        const debugInfo = `\n\n[Debug Info]\nRequested Model: ${requestedModel || "Unknown"}\nEffective Model: ${effectiveModel || "Unknown"}\nProject: ${projectId || "Unknown"}\nEndpoint: ${endpoint || "Unknown"}\nStatus: ${response.status}\nRequest ID: ${headers.get("x-request-id") || "N/A"}${toolDebugMissing !== undefined ? `\nTool Debug Missing: ${toolDebugMissing}` : ""}${toolDebugSummary ? `\nTool Debug Summary: ${toolDebugSummary}` : ""}${toolDebugPayload ? `\nTool Debug Payload: ${toolDebugPayload}` : ""}`
        const injectedDebug = debugText ? `\n\n${debugText}` : ""
        errorBody.error.message = (errorBody.error.message || "Unknown error") + debugInfo + injectedDebug

        const errorType = detectErrorType(errorBody.error.message || "")
        if (errorType === "thinking_block_order") {
          const recoveryError = new Error("THINKING_RECOVERY_NEEDED")
          ;(recoveryError as any).recoveryType = errorType
          ;(recoveryError as any).originalError = errorBody
          ;(recoveryError as any).debugInfo = debugInfo
          throw recoveryError
        }

        const errorMessage = errorBody.error.message?.toLowerCase() || ""
        if (
          errorMessage.includes("prompt is too long") ||
          errorMessage.includes("context length exceeded") ||
          errorMessage.includes("context_length_exceeded") ||
          errorMessage.includes("maximum context length")
        ) {
          headers.set("x-antigravity-context-error", "prompt_too_long")
        }

        if (
          errorMessage.includes("tool_use") &&
          errorMessage.includes("tool_result") &&
          (errorMessage.includes("without") || errorMessage.includes("immediately after"))
        ) {
          headers.set("x-antigravity-context-error", "tool_pairing")
        }

        return new Response(JSON.stringify(errorBody), {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      }

      if (errorBody?.error?.details && Array.isArray(errorBody.error.details)) {
        const retryInfo = errorBody.error.details.find(
          (detail: any) => detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
        )

        if (retryInfo?.retryDelay) {
          const match = retryInfo.retryDelay.match(/^([\d.]+)s$/)
          if (match && match[1]) {
            const retrySeconds = parseFloat(match[1])
            if (!isNaN(retrySeconds) && retrySeconds > 0) {
              const retryAfterSec = Math.ceil(retrySeconds).toString()
              const retryAfterMs = Math.ceil(retrySeconds * 1000).toString()
              headers.set("Retry-After", retryAfterSec)
              headers.set("retry-after-ms", retryAfterMs)
            }
          }
        }
      }
    }

    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    }

    const usageFromSse = streaming && isEventStreamResponse ? extractUsageFromSsePayload(text) : null
    const parsed: AntigravityApiBody | null =
      !streaming || !isEventStreamResponse ? parseAntigravityApiBody(text) : null
    const patched = parsed ? rewriteAntigravityPreviewAccessError(parsed, response.status, requestedModel) : null
    const effectiveBody = patched ?? parsed ?? undefined

    const usage = usageFromSse ?? (effectiveBody ? extractUsageMetadata(effectiveBody) : null)
    if (usage?.cachedContentTokenCount !== undefined) {
      headers.set("x-antigravity-cached-content-token-count", String(usage.cachedContentTokenCount))
      if (usage.totalTokenCount !== undefined) {
        headers.set("x-antigravity-total-token-count", String(usage.totalTokenCount))
      }
      if (usage.promptTokenCount !== undefined) {
        headers.set("x-antigravity-prompt-token-count", String(usage.promptTokenCount))
      }
      if (usage.candidatesTokenCount !== undefined) {
        headers.set("x-antigravity-candidates-token-count", String(usage.candidatesTokenCount))
      }
    }

    logAntigravityDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (buffered fallback)" : undefined,
      headersOverride: headers,
    })

    if (!parsed) {
      return new Response(text, init)
    }

    if (effectiveBody?.response !== undefined) {
      let responseBody: unknown = effectiveBody.response
      if (debugText) {
        responseBody = injectDebugThinking(responseBody, debugText)
      }
      const transformed = transformThinkingParts(responseBody)
      return new Response(JSON.stringify(transformed), init)
    }

    if (patched) {
      return new Response(JSON.stringify(patched), init)
    }

    return new Response(text, init)
  } catch (error) {
    logAntigravityDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Antigravity response",
    })
    return response
  }
}

export const __testExports = {
  buildSignatureSessionKey,
  hashConversationSeed,
  extractTextFromContent,
  extractConversationSeedFromMessages,
  extractConversationSeedFromContents,
  resolveConversationKey,
  resolveProjectKey,
  isGeminiToolUsePart,
  isGeminiThinkingPart,
  ensureThoughtSignature,
  hasSignedThinkingPart,
  hasSignedThinkingInContents,
  hasSignedThinkingInMessages,
  hasToolUseInContents,
  hasToolUseInMessages,
  ensureThinkingBeforeToolUseInContents,
  ensureThinkingBeforeToolUseInMessages,
  generateSyntheticProjectId,
  MIN_SIGNATURE_LENGTH,
  transformSseLine,
  transformStreamingPayload,
  createStreamingTransformer,
}
