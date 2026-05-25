import z from "zod"

import { Session } from "@/session"
import type { MessageV2 } from "@/session/message-v2"

import { Tool } from "./tool"

const parameters = z.object({
  since_minutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional()
    .describe(
      "How many minutes back to look. Default 60. Max 1440 (24h). Increase if you need older history.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum entries to return. Default 30. Newest first."),
})

const PER_ENTRY_CHAR_CAP = 400

function clip(text: string | undefined, cap = PER_ENTRY_CHAR_CAP): string {
  if (!text) return ""
  const oneLine = text.replace(/\s+/g, " ").trim()
  if (oneLine.length <= cap) return oneLine
  return oneLine.slice(0, cap - 3) + "..."
}

function hhmm(epochMs: number | undefined): string {
  if (!epochMs) return "--:--"
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
}

function renderPart(role: string, ts: number | undefined, part: MessageV2.Part): string | null {
  const head = `[${hhmm(ts)} ${role}]`
  switch (part.type) {
    case "text": {
      const t = clip((part as { text?: string }).text)
      if (!t) return null
      return `${head} text="${t}"`
    }
    case "reasoning": {
      const t = clip((part as { text?: string }).text)
      if (!t) return null
      return `${head} reasoning="${t}"`
    }
    case "tool": {
      const p = part as {
        tool?: string
        state?: { input?: unknown; output?: string; status?: string }
      }
      const name = p.tool ?? "?"
      const status = p.state?.status ?? "?"
      const args = clip(p.state?.input ? JSON.stringify(p.state.input) : "", 160)
      const out = clip(p.state?.output, 200)
      return `${head} tool=${name} status=${status} args=${args} output=${out}`
    }
    case "patch": {
      const p = part as { state?: { metadata?: { files?: Array<{ relativePath?: string; type?: string }> } } }
      const files = p.state?.metadata?.files ?? []
      const fileList = files
        .map((f) => `${f.type?.[0]?.toUpperCase() ?? "?"} ${f.relativePath ?? "?"}`)
        .slice(0, 5)
        .join(", ")
      return `${head} patch files=[${fileList || "none"}]`
    }
    default:
      return null
  }
}

export const SessionRecallTool = Tool.define("session_recall", {
  description:
    "Query your own session's past actions, reasoning, tool calls, and patches directly from the session database. " +
    "Use this when your prompt context appears thin (compacted anchor, post-/reload, post-rotation) and you need to verify what you actually did, what files you read, what apply_patch wrote, or recover the gist of prior reasoning. " +
    "The database always holds the FULL history even if your visible context was compacted to a short anchor. " +
    "Default returns the last 30 entries from the past 60 minutes, newest first. Each entry is truncated; if you need full output of a specific past tool call you can re-issue the read/bash. " +
    "Cheaper than re-running tools: one call surfaces dozens of past actions in compact form.",
  parameters,
  async execute(
    params,
    ctx,
  ): Promise<{
    title: string
    metadata: { entries: number; truncated: boolean; sinceMinutes: number }
    output: string
  }> {
    const sinceMin = params.since_minutes ?? 60
    const limit = params.limit ?? 30
    const cutoffMs = Date.now() - sinceMin * 60_000

    const messages = await Session.messages({ sessionID: ctx.sessionID }).catch(
      () => [] as MessageV2.WithParts[],
    )

    // Walk newest-first, collect rendered lines until we hit limit or cutoff.
    const lines: string[] = []
    let scanned = 0
    let earliestMs: number | undefined
    for (let mi = messages.length - 1; mi >= 0 && lines.length < limit; mi--) {
      const msg = messages[mi]
      const ts = msg.info.time?.created
      if (ts !== undefined && ts < cutoffMs) break
      scanned++
      const role = msg.info.role
      // Render parts newest-first within a message (matches "what was the last thing I did" intuition).
      for (let pi = msg.parts.length - 1; pi >= 0 && lines.length < limit; pi--) {
        const rendered = renderPart(role, ts, msg.parts[pi])
        if (rendered) {
          lines.push(rendered)
          earliestMs = ts
        }
      }
    }

    if (lines.length === 0) {
      return {
        title: "session_recall (empty)",
        metadata: { entries: 0, truncated: false, sinceMinutes: sinceMin },
        output: `No entries in the last ${sinceMin} minutes. Try a larger since_minutes, or this may be a genuinely fresh session.`,
      }
    }

    // Reverse so output reads oldest → newest within the window (easier to follow narrative).
    lines.reverse()

    const truncated = lines.length === limit && scanned < messages.length
    const window =
      earliestMs !== undefined
        ? ` (window: ${hhmm(earliestMs)} → ${hhmm(Date.now())})`
        : ""
    const header = `Session recall — ${lines.length} entries from last ${sinceMin} min${window}.${truncated ? " More history available; raise since_minutes or limit to see older." : ""}`
    return {
      title: `session_recall (${lines.length} entries)`,
      metadata: { entries: lines.length, truncated, sinceMinutes: sinceMin },
      output: `${header}\n\n${lines.join("\n")}`,
    }
  },
})
