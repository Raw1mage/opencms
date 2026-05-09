import type { MessageV2 } from "./message-v2"

const ARGS_TRUNCATION_CAP = 500
const TRUNCATION_MARKER = "…"

export interface SerializeOptions {
  /** Round number to start counting from. Default 1. */
  startRound?: number
  /**
   * User message id to skip during serialisation. The entire round headed
   * by this user message is omitted (Spec 1 synergy — unanswered user msgs
   * are handled by replayUnansweredUserMessage, not by extend).
   */
  excludeUserMessageID?: string
}

export interface SerializeResult {
  text: string
  lastRound: number
  messagesEmitted: number
}

interface RoundDraft {
  number: number
  userMessage: MessageV2.WithParts
  assistantMessages: MessageV2.WithParts[]
}

export function serializeRedactedDialog(
  messages: MessageV2.WithParts[],
  options: SerializeOptions = {},
): SerializeResult {
  const startRound = Math.max(1, options.startRound ?? 1)
  const excludeId = options.excludeUserMessageID
  const rounds: RoundDraft[] = []
  let nextRoundNumber = startRound
  let messagesEmitted = 0

  let current: RoundDraft | null = null

  for (const m of messages) {
    if (m.info.role === "user") {
      if (current) rounds.push(current)
      current = {
        number: nextRoundNumber,
        userMessage: m,
        assistantMessages: [],
      }
      nextRoundNumber += 1
      continue
    }
    if (m.info.role === "assistant") {
      if (current) current.assistantMessages.push(m)
      continue
    }
  }
  if (current) rounds.push(current)

  const blocks: string[] = []
  let lastRound = startRound - 1

  for (const round of rounds) {
    if (excludeId && round.userMessage.info.id === excludeId) continue
    const block = renderRound(round)
    if (!block) continue
    blocks.push(block)
    lastRound = round.number
    messagesEmitted += 1 + round.assistantMessages.length
  }

  return {
    text: blocks.join("\n\n"),
    lastRound: lastRound < startRound - 1 ? 0 : Math.max(lastRound, 0),
    messagesEmitted,
  }
}

function renderRound(round: RoundDraft): string {
  const sections: string[] = []
  sections.push(`## Round ${round.number}`)

  const userText = userMessageText(round.userMessage)
  sections.push("**User**")
  sections.push(userText.length > 0 ? userText : "_(empty)_")

  for (const a of round.assistantMessages) {
    const renderedAssistant = renderAssistantParts(a)
    if (renderedAssistant.length > 0) {
      sections.push(...renderedAssistant)
    }
  }

  return sections.join("\n\n")
}

function userMessageText(msg: MessageV2.WithParts): string {
  const fragments: string[] = []
  for (const p of msg.parts) {
    if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
      fragments.push(p.text)
    }
  }
  return fragments.join("\n").trim()
}

function renderAssistantParts(msg: MessageV2.WithParts): string[] {
  const out: string[] = []
  const reasoning = collectText(msg.parts, "reasoning")
  if (reasoning) {
    out.push("**Reasoning**")
    out.push(reasoning)
  }
  const text = collectText(msg.parts, "text")
  if (text) {
    out.push("**Assistant**")
    out.push(text)
  }
  for (const p of msg.parts) {
    if (p.type !== "tool") continue
    const status = (p as MessageV2.ToolPart).state?.status
    if (status !== "completed" && status !== "error") continue
    out.push(renderToolPart(p as MessageV2.ToolPart))
  }
  return out
}

function collectText(parts: MessageV2.Part[], type: "text" | "reasoning"): string {
  const fragments: string[] = []
  for (const p of parts) {
    if (p.type !== type) continue
    const candidate = (p as { text?: string }).text
    if (typeof candidate === "string" && candidate.length > 0) {
      fragments.push(candidate)
    }
  }
  return fragments.join("\n").trim()
}

function renderToolPart(part: MessageV2.ToolPart): string {
  const args = serializeToolArgs(part.state?.input ?? {})
  return `**Tool**: \`${part.tool}(${args})\` → \`recall_id: ${part.id}\``
}

function serializeToolArgs(input: unknown): string {
  let json: string
  try {
    json = JSON.stringify(input ?? {})
  } catch {
    json = "{}"
  }
  if (json.length <= ARGS_TRUNCATION_CAP) return json
  return json.slice(0, ARGS_TRUNCATION_CAP) + TRUNCATION_MARKER
}

/**
 * Walk messages newest-first to identify the most-recent user message
 * whose nearest assistant child has finish ∉ {stop, tool-calls, length}
 * (or no assistant child at all). Mirrors the logic of
 * SessionCompaction.snapshotUnansweredUserMessage but returns id only —
 * synchronous, no Session.messages dependency. Caller passes the already-
 * loaded message stream.
 *
 * Spec 1 synergy: caller threads this id into serializeRedactedDialog
 * via excludeUserMessageID so the unanswered user msg is excluded from
 * extend (it will be replayed post-anchor by the replay helper).
 */
export function findUnansweredUserMessageId(
  messages: MessageV2.WithParts[],
  prevAnchorIdx?: number,
): string | undefined {
  const start = (prevAnchorIdx ?? -1) + 1
  let userIdx = -1
  for (let i = messages.length - 1; i >= start; i--) {
    if (messages[i].info.role === "user") {
      userIdx = i
      break
    }
  }
  if (userIdx === -1) return undefined

  let assistantChild: MessageV2.WithParts | undefined
  for (let i = userIdx + 1; i < messages.length; i++) {
    if (messages[i].info.role === "assistant") {
      assistantChild = messages[i]
      break
    }
  }

  if (assistantChild) {
    const finish = (assistantChild.info as MessageV2.Assistant).finish
    if (finish === "stop" || finish === "tool-calls" || finish === "length") {
      return undefined
    }
  }

  return messages[userIdx].info.id
}

const ROUND_HEADER_RE = /^## Round (\d+)\s*$/gm

/**
 * Scan a previous anchor body for the highest `## Round N` header. Returns
 * 0 if none found. Used by tryNarrative to continue numbering across
 * extend cycles (CRR-005 fallback covers anchors written by legacy
 * tryNarrative or post-recompress LLM summaries that stripped headers).
 */
export function parsePrevLastRound(prevBody: string): number {
  if (!prevBody) return 0
  ROUND_HEADER_RE.lastIndex = 0
  let max = 0
  let m: RegExpExecArray | null
  while ((m = ROUND_HEADER_RE.exec(prevBody)) !== null) {
    const n = Number.parseInt(m[1], 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return max
}
