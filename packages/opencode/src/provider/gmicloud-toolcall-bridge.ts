const TOOL_CALLS_BEGIN = "<|tool_calls_begin|>"
const TOOL_CALLS_END = "<|tool_calls_end|>"
const TOOL_CALL_BEGIN = "<|tool_call_begin|>"
const TOOL_CALL_END = "<|tool_call_end|>"
const TOOL_SEP = "<|tool_sep|>"

type ParsedToolCall = {
  name: string
  input: string
}

type ParsedProtocol = {
  cleanedText: string
  toolCalls: ParsedToolCall[]
}

function normalizeProtocolMarkers(text: string): string {
  const canonical = text
    .replace(/｜/g, "|")
    .replace(/＜/g, "<")
    .replace(/＞/g, ">")
    .replace(/▁/g, "_")

  return canonical
    .replace(/<\|\s*tool_calls_begin\s*\|>?/gi, TOOL_CALLS_BEGIN)
    .replace(/<\|\s*tool_calls_end\s*\|>?\s*>?/gi, TOOL_CALLS_END)
    .replace(/<\|\s*tool_call_begin\s*\|>?/gi, TOOL_CALL_BEGIN)
    .replace(/<\|\s*tool_call_end\s*\|>?\s*>?/gi, TOOL_CALL_END)
    .replace(/<\|\s*tool_sep\s*\|>?/gi, TOOL_SEP)
}

function stripCodeFence(value: string) {
  const trimmed = value.trim()
  const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/)
  if (fenced) return fenced[1].trim()
  return trimmed.replace(/^`+|`+$/g, "").trim()
}

function splitTopLevel(input: string, separator: string) {
  const parts: string[] = []
  let current = ""
  let depthBrace = 0
  let depthBracket = 0
  let inString = false
  let quote: '"' | "'" | undefined
  let escaped = false

  for (const ch of input) {
    if (inString) {
      current += ch
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (ch === quote) {
        inString = false
        quote = undefined
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      current += ch
      continue
    }
    if (ch === "{") depthBrace++
    if (ch === "}") depthBrace--
    if (ch === "[") depthBracket++
    if (ch === "]") depthBracket--

    if (ch === separator && depthBrace === 0 && depthBracket === 0) {
      const part = current.trim()
      if (part) parts.push(part)
      current = ""
      continue
    }
    current += ch
  }

  const last = current.trim()
  if (last) parts.push(last)
  return parts
}

function parseLiteralValue(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ""
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const inner = trimmed.slice(1, -1)
    return inner.replace(/\\(["'])/g, "$1")
  }
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed === "null") return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Keep as raw string fallback below.
    }
  }
  return trimmed
}

function parseObjectLiteral(text: string): Record<string, unknown> | null {
  const source = text.trim()
  if (!source.startsWith("{") || !source.endsWith("}")) return null
  const inner = source.slice(1, -1).trim()
  if (!inner) return {}

  const result: Record<string, unknown> = {}
  const entries = splitTopLevel(inner, ",")
  for (const entry of entries) {
    const idx = entry.indexOf(":")
    if (idx <= 0) return null
    const rawKey = entry.slice(0, idx).trim()
    const rawValue = entry.slice(idx + 1).trim()
    const key = rawKey.replace(/^["']|["']$/g, "")
    if (!key) return null
    result[key] = parseLiteralValue(rawValue)
  }
  return result
}

function parseToolInput(rawInput: string): string {
  const cleaned = stripCodeFence(rawInput)
  if (!cleaned) return "{}"
  try {
    return JSON.stringify(JSON.parse(cleaned))
  } catch {
    const parsedObject = parseObjectLiteral(cleaned)
    if (parsedObject) return JSON.stringify(parsedObject)
    return JSON.stringify({ input: cleaned })
  }
}

export function extractGmiCloudTextProtocolToolCalls(text: string): ParsedProtocol | null {
  const normalized = normalizeProtocolMarkers(text)
  const toolCalls: ParsedToolCall[] = []
  const callRanges: Array<{ start: number; end: number }> = []
  let searchIndex = 0
  while (true) {
    const callStart = normalized.indexOf(TOOL_CALL_BEGIN, searchIndex)
    if (callStart === -1) break
    const callEndMarker = normalized.indexOf(TOOL_CALL_END, callStart + TOOL_CALL_BEGIN.length)
    if (callEndMarker === -1) break
    const callEnd = callEndMarker + TOOL_CALL_END.length
    callRanges.push({ start: callStart, end: callEnd })

    const payload = normalized.slice(callStart + TOOL_CALL_BEGIN.length, callEndMarker).trim()
    const sepIndex = payload.indexOf(TOOL_SEP)
    if (sepIndex > -1) {
      const rawType = payload.slice(0, sepIndex).trim()
      const nameAndInput = payload.slice(sepIndex + TOOL_SEP.length).trim()
      if (rawType === "function") {
        const firstLineBreak = nameAndInput.search(/\r?\n/)
        const name = (firstLineBreak === -1 ? nameAndInput : nameAndInput.slice(0, firstLineBreak)).trim()
        const rawInput = firstLineBreak === -1 ? "{}" : nameAndInput.slice(firstLineBreak).trim()
        if (name) {
          toolCalls.push({
            name,
            input: parseToolInput(rawInput),
          })
        }
      }
    }
    searchIndex = callEnd
  }

  if (toolCalls.length === 0) return null

  const ranges = [...callRanges]
  let blockSearch = 0
  while (true) {
    const blockStart = normalized.indexOf(TOOL_CALLS_BEGIN, blockSearch)
    if (blockStart === -1) break
    const blockEndMarker = normalized.indexOf(TOOL_CALLS_END, blockStart + TOOL_CALLS_BEGIN.length)
    if (blockEndMarker === -1) break
    ranges.push({ start: blockStart, end: blockStart + TOOL_CALLS_BEGIN.length })
    ranges.push({ start: blockEndMarker, end: blockEndMarker + TOOL_CALLS_END.length })
    blockSearch = blockEndMarker + TOOL_CALLS_END.length
  }

  ranges.sort((a, b) => a.start - b.start)
  let cleanedText = ""
  let cursor = 0
  for (const range of ranges) {
    if (range.start < cursor) continue
    if (cursor < range.start) cleanedText += normalized.slice(cursor, range.start)
    cursor = range.end
  }
  if (cursor < normalized.length) cleanedText += normalized.slice(cursor)
  cleanedText = cleanedText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()

  return {
    cleanedText,
    toolCalls,
  }
}

function rewriteNonStreamPayload(raw: string): string | null {
  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  const choice = payload?.choices?.[0]
  const message = choice?.message
  if (!message || message.tool_calls) return null
  if (typeof message.content !== "string" || message.content.length === 0) return null

  const parsed = extractGmiCloudTextProtocolToolCalls(message.content)
  if (!parsed) return null

  message.content = parsed.cleanedText.length > 0 ? parsed.cleanedText : null
  message.tool_calls = parsed.toolCalls.map((call, index) => ({
    id: `gmi-tool-${index + 1}`,
    type: "function",
    function: {
      name: call.name,
      arguments: call.input,
    },
  }))

  if (choice.finish_reason !== "tool_calls") {
    choice.finish_reason = "tool_calls"
  }

  return JSON.stringify(payload)
}

function rewriteStreamPayload(raw: string): string | null {
  const lines = raw.split(/\r?\n/)
  const dataLines = lines.filter((line) => line.startsWith("data: "))
  const chunks: any[] = []
  let hasToolCalls = false
  let text = ""

  for (const line of dataLines) {
    const body = line.slice(6).trim()
    if (!body || body === "[DONE]") continue
    try {
      const chunk = JSON.parse(body)
      chunks.push(chunk)
      const delta = chunk?.choices?.[0]?.delta
      if (delta?.tool_calls) hasToolCalls = true
      if (typeof delta?.content === "string") text += delta.content
    } catch {
      // Ignore malformed lines from provider; fallback to no rewrite.
      return null
    }
  }

  if (hasToolCalls || !text) return null
  const parsed = extractGmiCloudTextProtocolToolCalls(text)
  if (!parsed) return null

  const base = chunks[0] ?? {}
  const id = base.id ?? "chatcmpl-gmi-rewrite"
  const created = base.created ?? Math.floor(Date.now() / 1000)
  const model = base.model

  const out: string[] = []
  out.push(
    `data: ${JSON.stringify({
      id,
      created,
      ...(model ? { model } : {}),
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}`,
  )

  if (parsed.cleanedText.length > 0) {
    out.push(
      `data: ${JSON.stringify({
        id,
        created,
        ...(model ? { model } : {}),
        choices: [{ index: 0, delta: { content: parsed.cleanedText }, finish_reason: null }],
      })}`,
    )
  }

  parsed.toolCalls.forEach((toolCall, index) => {
    out.push(
      `data: ${JSON.stringify({
        id,
        created,
        ...(model ? { model } : {}),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: `gmi-tool-${index + 1}`,
                  type: "function",
                  function: {
                    name: toolCall.name,
                    arguments: toolCall.input,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}`,
    )
  })

  out.push(
    `data: ${JSON.stringify({
      id,
      created,
      ...(model ? { model } : {}),
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}`,
  )
  out.push("data: [DONE]")

  return `${out.join("\n\n")}\n\n`
}

export function rewriteGmiCloudToolCallPayload(raw: string, stream: boolean): string | null {
  return stream ? rewriteStreamPayload(raw) : rewriteNonStreamPayload(raw)
}

