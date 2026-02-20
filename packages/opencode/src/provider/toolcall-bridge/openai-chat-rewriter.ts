import type { ParsedToolCallContent } from "./types"

type Extractor = (text: string) => ParsedToolCallContent | null

type RewriteOptions = {
  stream: boolean
  extractor: Extractor
  toolCallIdPrefix: string
}

function rewriteNonStreamPayload(raw: string, extractor: Extractor, toolCallIdPrefix: string): string | null {
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

  const parsed = extractor(message.content)
  if (!parsed) return null

  message.content = parsed.cleanedText.length > 0 ? parsed.cleanedText : null
  message.tool_calls = parsed.toolCalls.map((call, index) => ({
    id: `${toolCallIdPrefix}-${index + 1}`,
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

function rewriteStreamPayload(raw: string, extractor: Extractor, toolCallIdPrefix: string): string | null {
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
      return null
    }
  }

  if (hasToolCalls || !text) return null
  const parsed = extractor(text)
  if (!parsed) return null

  const base = chunks[0] ?? {}
  const id = base.id ?? "chatcmpl-toolcall-rewrite"
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
                  id: `${toolCallIdPrefix}-${index + 1}`,
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

export function rewriteOpenAIChatToolCallPayload(raw: string, options: RewriteOptions): string | null {
  return options.stream
    ? rewriteStreamPayload(raw, options.extractor, options.toolCallIdPrefix)
    : rewriteNonStreamPayload(raw, options.extractor, options.toolCallIdPrefix)
}
