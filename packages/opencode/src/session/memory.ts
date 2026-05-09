import { Log } from "@/util/log"
import { SharedContext } from "./shared-context"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { isNarrationAssistantMessage } from "./narration"

// ── Memory ────────────────────────────────────────────────────────────────────
//
// Phase 13.1 (REVISED 2026-04-28): Memory is a render-time derivation of the
// messages stream. NO file IO, NO separate persistence — the messages stream
// is the single source of truth (compaction-redesign DD-2 single-source-of-
// truth). `Memory.read(sid)` walks the stream:
//
//   - Most recent anchor (`assistant.summary === true`) seeds the first
//     "rolled-up" TurnSummary; everything before it is gone (replaced by
//     the anchor's text).
//   - Post-anchor turns: each finished assistant message contributes its
//     last text part as a TurnSummary entry. Narration / unfinished /
//     subagent narration are skipped.
//   - Auxiliary fields (fileIndex, actionLog) come from SharedContext.Space
//     — that's a separate file/action workspace, not part of the stream.
//   - lastCompactedAt mirrors the most recent anchor's `time.created`. It's
//     vestigial (Cooldown now reads anchor.time directly) but kept for the
//     existing /session/:id/memory endpoint shape and downstream consumers.
//
// Render functions (renderForLLMSync, renderForHumanSync) take an already-
// loaded SessionMemory shape and stay pure / side-effect-free / testable.

export namespace Memory {
  const log = Log.create({ service: "session.memory" })

  // ── Data Model ─────────────────────────────────────────────

  export interface SessionMemory {
    sessionID: string
    version: number
    updatedAt: number
    turnSummaries: TurnSummary[]
    fileIndex: FileEntry[]
    actionLog: ActionEntry[]
    lastCompactedAt: { round: number; timestamp: number } | null
    rawTailBudget: number
  }

  export interface TurnSummary {
    turnIndex: number
    userMessageId: string
    assistantMessageId?: string
    endedAt: number
    text: string
    modelID: string
    providerId: string
    accountId?: string | null
    tokens?: { input?: number; output?: number }
  }

  export interface FileEntry {
    path: string
    operation: "read" | "edit" | "write" | "grep_match" | "glob_match"
    lines?: number | null
    summary?: string | null
    updatedAt: number
  }

  export interface ActionEntry {
    tool: string
    summary: string
    turn: number
    addedAt: number
  }

  const RAW_TAIL_BUDGET_DEFAULT = 5

  // ── Read (stream-derived) ──────────────────────────────────

  /**
   * Derive SessionMemory from the messages stream + SharedContext.Space
   * (file/action workspace, separate from compaction text).
   *
   * Caller may pass `messages` to skip the stream load — useful inside the
   * runloop where the stream is already in hand.
   */
  export async function read(
    sessionID: string,
    messages?: MessageV2.WithParts[],
  ): Promise<SessionMemory> {
    const msgs = messages ?? (await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[]))
    const anchorIdx = findMostRecentAnchorIndex(msgs)

    const turnSummaries: TurnSummary[] = []

    // Rolled-up first entry: the most recent anchor's text. Pre-anchor turns
    // are gone (the anchor IS the compacted summary that replaced them).
    if (anchorIdx !== -1) {
      const anchor = msgs[anchorIdx]
      const anchorText = textPartsJoined(anchor.parts)
      if (anchorText) {
        const info = anchor.info as MessageV2.Assistant
        turnSummaries.push({
          turnIndex: 0,
          userMessageId: "<prior-anchor>",
          assistantMessageId: info.id,
          endedAt: info.time?.completed ?? info.time?.created ?? 0,
          text: anchorText,
          modelID: info.modelID,
          providerId: info.providerId,
          accountId: info.accountId ?? null,
        })
      }
    }

    // Post-anchor turns. Walk forward; each finished assistant message
    // (excluding narration / anchors / subagent narration) contributes its
    // last text part as a turn-summary entry.
    const start = anchorIdx === -1 ? 0 : anchorIdx + 1
    let prevUser: MessageV2.User | undefined
    for (let i = start; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.info.role === "user") {
        prevUser = m.info as MessageV2.User
        continue
      }
      if (m.info.role !== "assistant") continue
      const info = m.info as MessageV2.Assistant
      if (info.summary === true) continue
      if (!info.finish) continue
      if (isNarrationAssistantMessage(info, m.parts)) continue
      const text = lastNarrativePartText(m.parts)
      if (!text.trim()) continue
      turnSummaries.push({
        turnIndex: turnSummaries.length,
        userMessageId: prevUser?.id ?? "",
        assistantMessageId: info.id,
        endedAt: info.time?.completed ?? info.time?.created ?? 0,
        text,
        modelID: info.modelID,
        providerId: info.providerId,
        accountId: info.accountId ?? null,
        tokens:
          info.tokens && (info.tokens.input || info.tokens.output)
            ? { input: info.tokens.input, output: info.tokens.output }
            : undefined,
      })
    }

    // Aux: file/action workspace from SharedContext.Space.
    const space = await SharedContext.get(sessionID).catch(() => undefined)
    const fileIndex: FileEntry[] = space
      ? space.files.map((f) => ({
          path: f.path,
          operation: f.operation,
          lines: f.lines ?? null,
          summary: f.summary ?? null,
          updatedAt: f.updatedAt,
        }))
      : []
    const actionLog: ActionEntry[] = space
      ? space.actions.map((a) => ({
          tool: a.tool,
          summary: a.summary,
          turn: a.turn,
          addedAt: a.addedAt,
        }))
      : []

    const lastCompactedAt =
      anchorIdx !== -1
        ? { round: 0, timestamp: msgs[anchorIdx].info.time?.created ?? 0 }
        : null

    return {
      sessionID,
      version: 1,
      updatedAt: Date.now(),
      turnSummaries,
      fileIndex,
      actionLog,
      lastCompactedAt,
      rawTailBudget: RAW_TAIL_BUDGET_DEFAULT,
    }
  }

  function findMostRecentAnchorIndex(msgs: MessageV2.WithParts[]): number {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = msgs[i].info
      if (info.role === "assistant" && (info as MessageV2.Assistant).summary === true) {
        return i
      }
    }
    return -1
  }

  function textPartsJoined(parts: MessageV2.Part[]): string {
    return parts
      .filter((p): p is MessageV2.TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim()
  }

  function lastNarrativePartText(parts: MessageV2.Part[]): string {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]
      if (p.type === "text") return (p as MessageV2.TextPart).text ?? ""
      if (p.type === "reasoning") return (p as MessageV2.ReasoningPart).text ?? ""
    }
    return ""
  }

  // ── Render (DD-5) ──────────────────────────────────────────

  /**
   * Compact provider-agnostic plain text for the next LLM call.
   *
   * Format priorities (in order):
   *   1. Token economy — concatenate TurnSummary.text without per-turn
   *      headers; consumer doesn't need to know boundaries to use the
   *      content as context.
   *   2. Provider-agnostic — never embeds tool-call format, model IDs,
   *      account IDs, or other provider-specific metadata. Plain prose +
   *      bullet lists only. This is what makes the format safe across
   *      provider switch (R-5).
   *   3. Auxiliary metadata only when narrative empty — if turnSummaries
   *      is empty, fall back to a minimal description of fileIndex
   *      (touched files) + actionLog so the next LLM call has at least
   *      something. Once narrative accumulates, this fallback is unused.
   *
   * Returns empty string if Memory has nothing useful — caller must
   * decide what to do (typically: skip this kind, fall through chain).
   */
  export async function renderForLLM(sessionID: string): Promise<string> {
    const mem = await read(sessionID)
    return renderForLLMSync(mem)
  }

  /**
   * Pure render from an already-loaded SessionMemory (testable, side-effect-free).
   *
   * `maxTokens` (optional): if set, caps output at this token estimate. Keeps
   * NEWEST turnSummaries that fit; drops oldest when the budget is tight.
   * Caller (compaction-redesign run() narrative kind) supplies this so the
   * resulting Anchor never blows past the upcoming-prompt budget.
   * Token estimate is `Math.ceil(text.length / 4)` (matches Token.estimate).
   */
  export function renderForLLMSync(mem: SessionMemory, maxTokens?: number): string {
    if (mem.turnSummaries.length > 0) {
      const trimmed = mem.turnSummaries.map((t) => t.text.trim()).filter(Boolean)
      if (typeof maxTokens !== "number" || maxTokens <= 0) {
        return trimmed.join("\n\n")
      }
      // Keep newest-first: walk from the end, accumulate until budget exhausted.
      const maxChars = maxTokens * 4
      const kept: string[] = []
      let used = 0
      for (let i = trimmed.length - 1; i >= 0; i--) {
        const candidate = trimmed[i]
        const next = used + (used > 0 ? 2 : 0) + candidate.length // 2 chars for "\n\n" join
        if (next > maxChars) {
          if (kept.length === 0) {
            // Single newest entry exceeds budget alone — truncate it from the END
            // (preserve the start, which usually has the goal/headline).
            return candidate.slice(0, maxChars)
          }
          break
        }
        kept.unshift(candidate)
        used = next
      }
      return kept.join("\n\n")
    }

    // No narrative — render auxiliary metadata as a minimal fallback.
    if (mem.fileIndex.length === 0 && mem.actionLog.length === 0) return ""

    const lines: string[] = []
    if (mem.fileIndex.length > 0) {
      lines.push("Files touched in this session:")
      for (const f of mem.fileIndex) {
        const meta = [f.lines ? `${f.lines} lines` : null, f.operation].filter(Boolean).join(", ")
        const suffix = f.summary ? ` — ${f.summary}` : ""
        lines.push(`- ${f.path} (${meta})${suffix}`)
      }
    }
    if (mem.actionLog.length > 0) {
      if (lines.length > 0) lines.push("")
      lines.push("Recent actions:")
      for (const a of mem.actionLog) lines.push(`- ${a.summary}`)
    }
    return lines.join("\n")
  }

  /**
   * Timeline format for human consumption (UI session-list preview, debug
   * dumps, /compact confirmation toast).
   */
  export async function renderForHuman(sessionID: string): Promise<string> {
    const mem = await read(sessionID)
    return renderForHumanSync(mem)
  }

  /** Pure render from an already-loaded SessionMemory (testable, side-effect-free). */
  export function renderForHumanSync(mem: SessionMemory): string {
    const lines: string[] = []
    lines.push(`# Session ${mem.sessionID}`)
    lines.push(`_version ${mem.version}, updated ${formatIsoFromMs(mem.updatedAt)}_`)
    lines.push("")

    if (mem.turnSummaries.length > 0) {
      for (const t of mem.turnSummaries) {
        lines.push(`## Turn ${t.turnIndex} — ${formatIsoFromMs(t.endedAt)}`)
        if (t.modelID && t.modelID !== "legacy") {
          lines.push(`_model ${t.providerId}/${t.modelID}_`)
        }
        lines.push("")
        lines.push(t.text.trim())
        lines.push("")
      }
    } else {
      lines.push("_(no turn summaries captured yet)_")
      lines.push("")
    }

    if (mem.fileIndex.length > 0) {
      lines.push("## Files touched")
      lines.push("")
      for (const f of mem.fileIndex) {
        const meta = [f.lines ? `${f.lines} lines` : null, f.operation].filter(Boolean).join(", ")
        const suffix = f.summary ? ` — ${f.summary}` : ""
        lines.push(`- ${f.path} (${meta})${suffix}`)
      }
      lines.push("")
    }

    if (mem.actionLog.length > 0) {
      lines.push("## Action log")
      lines.push("")
      for (const a of mem.actionLog) {
        lines.push(`- turn ${a.turn}: ${a.summary}`)
      }
      lines.push("")
    }

    if (mem.lastCompactedAt) {
      lines.push(
        `_last compacted at ${formatIsoFromMs(mem.lastCompactedAt.timestamp)}_`,
      )
    }

    return lines.join("\n")
  }

  function formatIsoFromMs(ms: number): string {
    if (!ms || !Number.isFinite(ms)) return "?"
    try {
      return new Date(ms).toISOString()
    } catch {
      return String(ms)
    }
  }

  // Phase 13.1: write / appendTurnSummary / markCompacted removed. Memory is
  // a derived view of the messages stream — there's nothing to persist
  // separately. Cooldown reads anchor message timestamps directly.
  void log

  // ───────────────────────────────────────────────────────────────────
  // Hybrid accessors — Phase 2 of context-management subsystem
  // (specs/tool-output-chunking/, refactor 2026-04-29).
  //
  // These are additive selectors over the message stream that the
  // hybrid-llm compaction path needs: get the most recent anchor, the
  // unpinned journal since that anchor, the pinned-zone source
  // tool_results, and recall a specific message from disk. Existing
  // Memory.read / renderForLLM / etc. are unchanged.
  //
  // INV-10: single source of truth is the on-disk message stream. None
  // of these accessors persist anything separately; they are pure views.
  //
  // Return types are raw MessageV2.WithParts so this file stays import-
  // cycle-free with compaction.ts. Callers in compaction.ts convert into
  // Hybrid.Anchor / Hybrid.JournalEntry / Hybrid.PinnedZoneEntry when
  // building the LLM_compact request.
  // ───────────────────────────────────────────────────────────────────
  export namespace Hybrid {
    /**
     * Most recent assistant message with `summary === true`. This IS the
     * anchor — schema unchanged from compaction-redesign DD-8 so legacy
     * narrative anchors are forward-compatible (DD-10 migration).
     *
     * Returns null on cold-start (no anchor yet).
     */
    export async function getAnchorMessage(
      sessionID: string,
      messages?: MessageV2.WithParts[],
    ): Promise<MessageV2.WithParts | null> {
      const msgs = messages ?? (await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[]))
      const idx = findMostRecentAnchorIndex(msgs)
      return idx === -1 ? null : msgs[idx]
    }

    /**
     * Journal slice = messages after the most recent anchor (or all of
     * them on cold-start), with tool_results for tool_call ids in
     * `dropMarkers` excluded. Adjacency invariant for tool_call /
     * tool_result pairs is preserved: when a tool_result is dropped,
     * its paired tool_call is also dropped to keep the stream
     * provider-validatable.
     *
     * Phase 1 LLM_compact reads this; Phase 2 reads journalAll (no
     * anchor cutoff). For Phase 2 callers, pass `includePreAnchor=true`.
     */
    export async function getJournalMessages(
      sessionID: string,
      opts?: {
        messages?: MessageV2.WithParts[]
        dropMarkers?: Set<string>
        includePreAnchor?: boolean
      },
    ): Promise<MessageV2.WithParts[]> {
      const msgs = opts?.messages ?? (await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[]))
      const drop = opts?.dropMarkers ?? new Set<string>()
      const startIdx =
        opts?.includePreAnchor || findMostRecentAnchorIndex(msgs) === -1
          ? 0
          : findMostRecentAnchorIndex(msgs) + 1

      const result: MessageV2.WithParts[] = []
      for (let i = startIdx; i < msgs.length; i++) {
        const m = msgs[i]
        // Filter parts: drop the listed tool_call ids and their matched
        // tool_result parts. We rebuild the parts array; if no parts
        // remain meaningful, the message is still kept (could be a user
        // message or assistant text without tools).
        if (drop.size === 0) {
          result.push(m)
          continue
        }
        const filteredParts = m.parts.filter((p) => {
          if (p.type === "tool") {
            const tcid = (p as MessageV2.ToolPart).callID
            if (tcid && drop.has(tcid)) return false
          }
          return true
        })
        if (filteredParts.length === m.parts.length) {
          result.push(m)
        } else {
          result.push({ ...m, parts: filteredParts })
        }
      }
      return result
    }

    /**
     * Pinned-zone source list — the original tool_results referenced by
     * `pin` markers in recent assistant message metadata. Returns the
     * raw tool messages; the caller wraps each as a synthesised
     * user-role envelope per DD-4 (closes G-1, INV-4).
     *
     * Stable order: pinned tool_results are returned in the order they
     * first appeared in the stream (chronological), so prompt-build
     * produces a deterministic pinned_zone shape inter-compaction.
     */
    export async function getPinnedToolMessages(
      sessionID: string,
      pinnedToolCallIds: ReadonlySet<string>,
      messages?: MessageV2.WithParts[],
    ): Promise<{ message: MessageV2.WithParts; toolPart: MessageV2.ToolPart }[]> {
      if (pinnedToolCallIds.size === 0) return []
      const msgs = messages ?? (await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[]))
      const out: { message: MessageV2.WithParts; toolPart: MessageV2.ToolPart }[] = []
      const seen = new Set<string>()
      for (const m of msgs) {
        for (const p of m.parts) {
          if (p.type !== "tool") continue
          const tp = p as MessageV2.ToolPart
          if (!tp.callID || seen.has(tp.callID)) continue
          if (pinnedToolCallIds.has(tp.callID)) {
            out.push({ message: m, toolPart: tp })
            seen.add(tp.callID)
          }
        }
      }
      return out
    }

    /**
     * Recall a specific message from disk by id (DD-7, INV-9).
     *
     * Cross-session via the optional sessionID argument — the parent of
     * a completed subagent (DD-8) recalls from the subagent's own
     * stream. Returns null if the message does not exist on disk.
     *
     * Idempotency check is the caller's responsibility (typically the
     * OverrideParser in prompt.ts checks whether the recalled content
     * is already in journal as a "[Recalled from earlier]" wrapped
     * entry before invoking this).
     */
    export async function recallMessage(
      sessionID: string,
      msgId: string,
    ): Promise<MessageV2.WithParts | null> {
      const msgs = await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])
      for (const m of msgs) {
        if (m.info?.id === msgId) return m
      }
      return null
    }
  }
}
