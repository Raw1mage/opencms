import type { AssistantMessage, Message, Part, ToolPart } from "@opencode-ai/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  usage: number | null
  /**
   * Estimated codex Responses-API `input` array length for the current
   * session, computed from the locally-stored message stream. Not the
   * exact count `[CODEX-WS] REQ` would log, but a faithful approximation:
   * each user/assistant text/each tool call/each tool result becomes one
   * input item under [packages/opencode-codex-provider/src/convert.ts](
   * ../../../../opencode-codex-provider/src/convert.ts) `convertPrompt`.
   * Surfaces because codex backend has a hidden item-array sensitivity
   * (~300+ items → ws_truncation / server_failed). Always provided so
   * the operator can correlate paralysis / failure events with itemCount
   * pressure independent of token usage.
   */
  inputItemCount: number
}

type Metrics = {
  totalCost: number
  context: Context | undefined
}

const tokenTotal = (msg: AssistantMessage) => {
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

/**
 * Estimate codex `input` array length over the stored message stream.
 * Mirrors the algorithm used at compaction-trigger time
 * ([packages/opencode/src/session/prompt.ts](
 * ../../../../opencode/src/session/prompt.ts) paralysis × bloated-input
 * coupling) so the operator-visible number matches what the runtime
 * actually evaluates.
 *
 * Counting rules:
 *   - user message → 1 item
 *   - assistant message with any non-empty text part → 1 item
 *   - each ToolPart on assistant → 1 item (function_call) plus 1 item
 *     when status is `completed` or `error` (function_call_output)
 */
const estimateInputItemCount = (
  messages: Message[],
  partsByMessageID: Record<string, Part[] | undefined>,
): number => {
  let count = 0
  for (const msg of messages) {
    if (msg.role === "user") {
      count += 1
      continue
    }
    if (msg.role === "assistant") {
      const parts = partsByMessageID[msg.id] ?? []
      let hasText = false
      for (const p of parts) {
        if (p.type === "text") {
          const text = (p as { text?: string }).text
          if (typeof text === "string" && text.length > 0) hasText = true
        }
      }
      if (hasText) count += 1
      for (const p of parts) {
        if (p.type !== "tool") continue
        const toolPart = p as ToolPart
        // function_call (always emitted for an assistant tool part)
        count += 1
        // function_call_output (emitted only when tool finished)
        const status = toolPart.state?.status
        if (status === "completed" || status === "error") count += 1
      }
    }
  }
  return count
}

const build = (
  messages: Message[] = [],
  providers: Provider[] = [],
  partsByMessageID: Record<string, Part[] | undefined> = {},
): Metrics => {
  const totalCost = messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)
  const message = lastAssistantWithTokens(messages)
  if (!message) return { totalCost, context: undefined }

  const providerID =
    (message as AssistantMessage & { providerId?: string }).providerId ??
    (message as AssistantMessage & { providerID?: string }).providerID
  const provider = providers.find((item) => item.id === providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
  const total = tokenTotal(message)

  return {
    totalCost,
    context: {
      message,
      provider,
      model,
      providerLabel: provider?.name ?? providerID,
      modelLabel: model?.name ?? message.modelID,
      limit,
      input: message.tokens.input,
      output: message.tokens.output,
      reasoning: message.tokens.reasoning,
      cacheRead: message.tokens.cache.read,
      cacheWrite: message.tokens.cache.write,
      total,
      usage: limit ? Math.round((total / limit) * 100) : null,
      inputItemCount: estimateInputItemCount(messages, partsByMessageID),
    },
  }
}

export function getSessionContextMetrics(
  messages: Message[] = [],
  providers: Provider[] = [],
  partsByMessageID: Record<string, Part[] | undefined> = {},
) {
  return build(messages, providers, partsByMessageID)
}
