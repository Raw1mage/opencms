/**
 * LMv2 ↔ Anthropic format converters.
 *
 * Phase 1: Request converters (LMv2 → Anthropic) and response type helpers.
 * Does NOT depend on @ai-sdk/anthropic.
 */
import type {
  LanguageModelV2Prompt,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider"
import {
  TOOL_PREFIX,
  BOUNDARY_MARKER,
  IDENTITY_INTERACTIVE,
  buildBillingHeader,
  CLAUDE_CACHE_TTL,
} from "./protocol.js"

// ---------------------------------------------------------------------------
// Anthropic API types (wire format)
// ---------------------------------------------------------------------------

export type CacheControl = { type: "ephemeral"; scope?: "global" | "org"; ttl?: string }

// Cache breakpoint factory — applies the extended TTL (CLAUDE_CACHE_TTL) uniformly
// to every breakpoint, mirroring official (one ttl mapped onto all breakpoints).
// When CLAUDE_CACHE_TTL is undefined the ttl key is omitted → Anthropic 5-min default.
function ephemeral(scope?: "global" | "org"): CacheControl {
  return {
    type: "ephemeral",
    ...(scope ? { scope } : {}),
    ...(CLAUDE_CACHE_TTL ? { ttl: CLAUDE_CACHE_TTL } : {}),
  }
}

export interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
  /**
   * True for the ephemeral per-turn context preface message (injected by
   * llm.ts before the last user turn). Mirrors official claude-code's
   * `type:"api_system"` injected messages: the conversation cache-breakpoint
   * finder (`applyConversationCacheBreakpoint`) SKIPS these so breakpoints land
   * on stable real conversation, not the volatile preface. Not sent on the wire.
   */
  isContextPreface?: boolean
}

export type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: CacheControl | null }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: CacheControl | null }
  | { type: "tool_use"; id: string; name: string; input: unknown; cache_control?: CacheControl | null }
  | { type: "tool_result"; tool_use_id: string; content?: string | AnthropicContentBlock[]; cache_control?: CacheControl | null }
  | { type: "thinking"; thinking: string; signature?: string; cache_control?: CacheControl | null }

export interface AnthropicSystemBlock {
  type: "text"
  text: string
  cache_control?: CacheControl | null
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: unknown
  cache_control?: CacheControl | null
}

// ---------------------------------------------------------------------------
// § 1A.1  convertPrompt — LMv2 messages → Anthropic messages + system
// ---------------------------------------------------------------------------

export function convertPrompt(prompt: LanguageModelV2Prompt): {
  messages: AnthropicMessage[]
  system: string | undefined
  /** Count of trailing assistant messages removed by the user-terminated guard
   *  below. >0 signals an upstream serialization defect the caller MUST log
   *  loudly (not silently swallow) — see the guard comment. */
  droppedTrailingAssistants: number
} {
  let system: string | undefined
  const messages: AnthropicMessage[] = []

  for (const msg of prompt) {
    switch (msg.role) {
      case "system":
        // System messages are concatenated — the provider will wrap them in blocks later
        system = system ? `${system}\n\n${msg.content}` : msg.content
        break

      case "user": {
        const blocks: AnthropicContentBlock[] = []
        for (const part of msg.content) {
          if (part.type === "text") {
            blocks.push({ type: "text", text: part.text })
          } else if (part.type === "file") {
            // Image or file content
            if (typeof part.data === "string") {
              // base64 string
              blocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: part.mediaType,
                  data: part.data,
                },
              })
            } else if (part.data instanceof URL) {
              // URL — Anthropic supports url source type but we convert to text reference
              blocks.push({
                type: "text",
                text: `[File: ${part.data.toString()}]`,
              })
            } else {
              // Uint8Array → base64
              const b64 = Buffer.from(part.data).toString("base64")
              blocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: part.mediaType,
                  data: b64,
                },
              })
            }
          }
        }
        if (blocks.length > 0) {
          // Carry the context-preface marker through so the breakpoint finder can
          // skip it (mirrors official `api_system` skip). Set by llm.ts on the
          // injected per-turn preface message via message-level providerOptions.
          const isContextPreface =
            (msg as { providerOptions?: { anthropic?: { contextPreface?: boolean } } }).providerOptions?.anthropic
              ?.contextPreface === true
          messages.push({ role: "user", content: blocks, ...(isContextPreface && { isContextPreface: true }) })
        }
        break
      }

      case "assistant": {
        const blocks: AnthropicContentBlock[] = []
        for (const part of msg.content) {
          if (part.type === "text") {
            blocks.push({ type: "text", text: part.text })
          } else if (part.type === "reasoning") {
            // Anthropic REQUIRES `signature` on thinking blocks replayed in
            // history (captured from signature_delta in the SSE response and
            // carried via providerOptions.anthropic.signature). A thinking block
            // without it is rejected ("thinking.signature: Field required"), so
            // drop unsigned reasoning rather than send an invalid block.
            const signature = (part.providerOptions as { anthropic?: { signature?: string } } | undefined)
              ?.anthropic?.signature
            if (typeof signature === "string" && signature.length > 0) {
              blocks.push({ type: "thinking", thinking: part.text, signature })
            }
          } else if (part.type === "tool-call") {
            const name = prefixToolName(part.toolName)
            blocks.push({
              type: "tool_use",
              id: part.toolCallId,
              name,
              input: typeof part.input === "string" ? safeParseJSON(part.input) : part.input,
            })
          }
          // file parts in assistant messages are ignored (not in Anthropic spec)
        }
        if (blocks.length > 0) {
          messages.push({ role: "assistant", content: blocks })
        }
        break
      }

      case "tool": {
        const blocks: AnthropicContentBlock[] = []
        for (const part of msg.content) {
          if (part.type === "tool-result") {
            const resultContent = formatToolResultOutput(part.output)
            blocks.push({
              type: "tool_result",
              tool_use_id: part.toolCallId,
              content: resultContent,
            })
          }
        }
        if (blocks.length > 0) {
          messages.push({ role: "user", content: blocks })
        }
        break
      }
    }
  }

  // Anthropic rejects a conversation that ends with an assistant message
  // ("This model does not support assistant message prefill. The conversation
  // must end with a user message."). A correct agentic turn ends with a
  // tool_result (user-role) message, so a trailing assistant only appears when
  // upstream assembly emits a non-user-terminated conversation (e.g. consecutive
  // assistant messages with a tool result not threaded back between them).
  //
  // We correct it here so the request is valid (Anthropic regenerates from the
  // last user/tool message), but this is NOT a silent fallback: the count is
  // returned so the caller logs it loudly. The trailing assistant is a symptom
  // of an upstream serialization defect that must stay visible.
  // See issues/bug_20260529_claude_assistant_prefill_400.md.
  let droppedTrailingAssistants = 0
  while (messages.length > 0 && messages[messages.length - 1]!.role === "assistant") {
    messages.pop()
    droppedTrailingAssistants++
  }

  return { messages, system, droppedTrailingAssistants }
}

// ---------------------------------------------------------------------------
// § 1A.2  convertTools — LMv2 function tools → Anthropic tools
// ---------------------------------------------------------------------------

export function convertTools(
  tools: LanguageModelV2FunctionTool[] | undefined,
  // Kept for caller-API stability. Tools intentionally no longer carry their own
  // cache_control breakpoint — see the budget note below (DD-8).
  _enableCaching = false,
): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  const result: AnthropicTool[] = tools.map((tool) => ({
    name: prefixToolName(tool.name),
    description: tool.description,
    input_schema: tool.inputSchema,
  }))

  // plan provider-claude_conversation-cache-breakpoint DD-8: NO cache_control on
  // the tools block. Anthropic's prompt-cache prefix order is tools → system →
  // messages, so the system breakpoint (convertSystemBlocks) already caches the
  // tools prefix — a separate tools breakpoint is redundant. Removing it frees a
  // slot under Anthropic's 4-breakpoint/request cap so the conversation can carry
  // TWO breakpoints (last + second-to-last, aligned to official `TF5`) instead of
  // one — the single sliding breakpoint was the cause of the warm/cold cache
  // thrash. Tool schemas stay cached (the stable ~33K-token floor) via the system
  // breakpoint. Official claude-code v2.1.112 likewise places zero cache_control
  // on tools.
  return result
}

/**
 * datasheet §9.2 + plan provider-claude_conversation-cache-breakpoint (DD-2/DD-7/
 * DD-8): conversation cache breakpoints aligned to official claude-code `TF5`.
 *
 * Marks the last content block of the LAST TWO messages with cache_control (the
 * official marker set M = {last} ∪ {second-to-last}). A last block that is a
 * `thinking`/`redacted_thinking` block is skipped, mirroring official `OF5`
 * (`A===length-1 && type!=="thinking" && type!=="redacted_thinking"`).
 *
 * Why two and not one: the second-to-last breakpoint coincides with the PREVIOUS
 * turn's last breakpoint, which is already in cache → a stable read-hit every
 * turn, instead of relying on implicit longest-prefix matching of a single
 * sliding breakpoint. The single-breakpoint version thrashed: cache_read
 * alternated ~194K (warm) ↔ 33204 (cold, only the system/tools prefix), and the
 * cold turns (cacheReadFraction≈0.166) fed the DD-16 claude cold-compaction gate
 * into rapid narrative compaction. See issues/bug_20260602_claude_cli_rapid_
 * narrative_compaction_cascade.md §3.x.
 *
 * Budget (Anthropic max 4 breakpoints/request, DD-8): tools(0) + system(2:
 * identity + static) + conversation(2) = 4. The tools breakpoint was dropped in
 * convertTools — the system breakpoint already caches the tools prefix via
 * Anthropic's tools→system→messages cache order.
 */
export function applyConversationCacheBreakpoint(
  messages: AnthropicMessage[],
  enableCaching = false,
): void {
  try {
    if (!enableCaching || messages.length === 0) return
    // Official `TF5` marker set M = {last} ∪ {second-to-last}, but its index finder
    // `f()` SKIPS injected api_system messages: `while(H[L].type==="api_system")L--`.
    // opencms's ephemeral context preface is the equivalent injected message — it is
    // re-spliced right before the last user turn every call, so a breakpoint on it
    // gives NO stable read-hit (its array position shifts as the conversation grows),
    // and the conversation falls back to the system-prefix floor → cold full-rewrite.
    // RCA: issues/bug_20260602_claude_cli_rapid_narrative_compaction_cascade §12.
    // Mirror `f()`: skip preface messages so both breakpoints land on stable REAL
    // conversation turns (the second-to-last then coincides with the previous turn's
    // last breakpoint = a stable read-hit, as the official design intends).
    const f = (from: number): number => {
      let i = from
      while (i >= 0 && messages[i]?.isContextPreface === true) i--
      return i
    }
    const lastIdx = f(messages.length - 1)
    const secondIdx = f(lastIdx - 1)
    for (const idx of [lastIdx, secondIdx]) {
      if (idx < 0) continue
      const msg = messages[idx]!
      if (!Array.isArray(msg.content) || msg.content.length === 0) continue
      const last = msg.content[msg.content.length - 1]!
      // thinking/redacted_thinking blocks are never cache breakpoints (official OF5)
      if (last.type === "thinking" || (last.type as string) === "redacted_thinking") continue
      last.cache_control = ephemeral()
    }
  } finally {
    // `isContextPreface` is an INTERNAL marker used ONLY for the breakpoint
    // finder above — it must NEVER reach the wire. Anthropic strictly validates
    // message objects and rejects unknown fields with
    //   invalid_request_error: messages.N.isContextPreface: Extra inputs are not permitted
    // This is the single consumer of the marker, so strip it here for EVERY
    // message, unconditionally (the finally runs even on the early-return /
    // caching-disabled path, where the marker is still present from convertPrompt).
    for (const m of messages) {
      if (m.isContextPreface !== undefined) delete m.isContextPreface
    }
  }
}

// ---------------------------------------------------------------------------
// § 1A.3  convertSystemBlocks — system text + sections → Anthropic system blocks
// ---------------------------------------------------------------------------

export interface ConvertSystemOptions {
  /** Raw system text from convertPrompt */
  systemText: string | undefined
  /** Whether prompt caching is enabled */
  enableCaching: boolean
  /** Identity string to prepend */
  identity?: string
  /** Content for billing header hash (first user message text) */
  billingContent?: string
  /** Entrypoint for billing header */
  entrypoint?: string
}

export function convertSystemBlocks(options: ConvertSystemOptions): AnthropicSystemBlock[] {
  const {
    systemText,
    enableCaching,
    identity = IDENTITY_INTERACTIVE,
    billingContent,
    entrypoint,
  } = options

  const blocks: AnthropicSystemBlock[] = []

  // Block 0: billing header (no cache)
  if (billingContent) {
    const headerText = `x-anthropic-billing-header: ${buildBillingHeader(billingContent, entrypoint)}`
    blocks.push({ type: "text", text: headerText, cache_control: null })
  }

  // Block 1: identity (org-level cache)
  blocks.push({
    type: "text",
    text: identity,
    ...(enableCaching && { cache_control: ephemeral("org") }),
  })

  if (!systemText) return blocks

  // Check for boundary marker
  const boundaryIdx = systemText.indexOf(BOUNDARY_MARKER)

  if (boundaryIdx !== -1) {
    // Mode B: Boundary-based cache
    const staticPart = systemText.slice(0, boundaryIdx).trim()
    const dynamicPart = systemText.slice(boundaryIdx + BOUNDARY_MARKER.length).trim()

    if (staticPart) {
      blocks.push({
        type: "text",
        text: staticPart,
        ...(enableCaching && { cache_control: ephemeral("global") }),
      })
    }

    if (dynamicPart) {
      blocks.push({ type: "text", text: dynamicPart })
    }
  } else {
    // Mode C: Fallback — all sections as org-level cache
    blocks.push({
      type: "text",
      text: systemText,
      ...(enableCaching && { cache_control: ephemeral("org") }),
    })
  }

  // Filter out empty text blocks
  return blocks.filter((b) => b.text && b.text.trim() !== "")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prefixToolName(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name : `${TOOL_PREFIX}${name}`
}

export function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name
}

function safeParseJSON(input: unknown): unknown {
  if (typeof input !== "string") return input
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

function formatToolResultOutput(output: unknown): string {
  if (!output || typeof output !== "object") return String(output ?? "")
  const o = output as { type?: string; value?: unknown }
  switch (o.type) {
    case "text":
    case "error-text":
      return String(o.value ?? "")
    case "json":
    case "error-json":
      return JSON.stringify(o.value)
    case "content": {
      const parts = o.value as Array<{ type: string; text?: string; data?: string }>
      return parts
        .map((p) => (p.type === "text" ? p.text : `[media:${p.data?.slice(0, 20)}...]`))
        .join("\n")
    }
    default:
      return JSON.stringify(output)
  }
}
