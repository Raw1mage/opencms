/**
 * TOOL_INDEX construction + validation (compaction/recall-affordance L1).
 *
 * Narrative-kind compaction produces an anchor body whose pre-anchor tool
 * results are collapsed into prose. Without a structured index of recallable
 * tool_call_ids, the AI cannot address those past results — even though the
 * data is still on-disk and retrievable via the recall tool (L2).
 *
 * This module:
 * 1. Extracts an index from the priorAnchor body (carries forward across
 *    compaction generations).
 * 2. Extracts an index from the current journal's tool calls.
 * 3. Renders a markdown table (## TOOL_INDEX) the LLM is instructed to
 *    preserve verbatim in the new anchor body.
 * 4. Validates the persisted anchor body has the section after the LLM
 *    finishes (telemetry hook).
 *
 * INV-6: total index size is capped at toolIndexBudget tokens; older entries
 * are truncated with a placeholder row.
 */

import { Log } from "@/util/log"

const log = Log.create({ service: "compaction.tool-index" })

export interface ToolIndexEntry {
  tool_call_id: string
  tool_name: string
  args_brief: string
  status: "ok" | "error" | "abort" | "unknown"
  output_chars: number
}

const ARGS_BRIEF_MAX = 80
const SECTION_MARKER = "## TOOL_INDEX"

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

function briefArgs(input: unknown): string {
  if (input === null || input === undefined) return ""
  if (typeof input === "string") return truncate(input, ARGS_BRIEF_MAX)
  try {
    return truncate(JSON.stringify(input), ARGS_BRIEF_MAX)
  } catch {
    return "(unserialisable)"
  }
}

/**
 * Walk a journal (Hybrid.JournalEntry[]) and pull out one TOOL_INDEX entry
 * per ToolPart encountered. Caller passes the journalUnpinned array from an
 * LLMCompactRequest. Pure function.
 *
 * Accepts a loosely-typed journal (any[]) so this module can be used without
 * a hard import cycle against compaction.ts's internal types. Each entry is
 * expected to have shape { messages: { parts: ... }[] }.
 */
export function extractFromJournal(journalUnpinned: any[]): ToolIndexEntry[] {
  const out: ToolIndexEntry[] = []
  for (const je of journalUnpinned ?? []) {
    for (const m of je?.messages ?? []) {
      for (const part of m?.parts ?? []) {
        if (part?.type !== "tool") continue
        const callID = String(part.callID ?? "")
        if (!callID) continue
        const toolName = String(part.tool ?? "unknown")
        const state = part.state ?? {}
        const status = ((): ToolIndexEntry["status"] => {
          if (state.status === "completed") return "ok"
          if (state.status === "error") return "error"
          if (state.status === "aborted") return "abort"
          return "unknown"
        })()
        const output =
          typeof state.output === "string"
            ? state.output
            : typeof state.error === "string"
              ? state.error
              : ""
        out.push({
          tool_call_id: callID,
          tool_name: toolName,
          args_brief: briefArgs(state.input ?? part.input),
          status,
          output_chars: output.length,
        })
      }
    }
  }
  return out
}

const ROW_REGEX = /^\|\s*([^\s|][^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(\d+)\s*\|$/

/**
 * Parse a TOOL_INDEX markdown section out of a body string (anchor content).
 * Tolerant of whitespace/formatting variance. Returns the parsed entries.
 * Used to (a) carry the index forward from priorAnchor into the next
 * compaction generation, and (b) validate post-write that the LLM emitted
 * a non-empty TOOL_INDEX.
 */
const MARKER_REGEX = /^#{2,3}\s+TOOL_INDEX\s*$/im

export function findMarkerIndex(body: string): number {
  if (!body) return -1
  const m = MARKER_REGEX.exec(body)
  return m ? m.index : -1
}

export function parseFromBody(body: string): ToolIndexEntry[] {
  if (!body) return []
  const markerIdx = findMarkerIndex(body)
  if (markerIdx === -1) return []
  const tail = body.slice(markerIdx)
  const lines = tail.split(/\r?\n/)
  const entries: ToolIndexEntry[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) continue
    if (/^\|\s*-+/.test(trimmed)) continue // separator row
    const m = ROW_REGEX.exec(trimmed)
    if (!m) continue
    const [, id, name, args, status, chars] = m
    if (id.toLowerCase() === "tool_call_id") continue // header
    // Filter placeholder rows emitted by renderSection for empty/truncated
    // states (they start with "(" which is not a valid tool_call_id).
    if (id.startsWith("(")) continue
    const normStatus: ToolIndexEntry["status"] =
      status === "ok" || status === "error" || status === "abort" ? status : "unknown"
    entries.push({
      tool_call_id: id,
      tool_name: name,
      args_brief: args,
      status: normStatus,
      output_chars: Number(chars) || 0,
    })
  }
  return entries
}

/**
 * Merge priorAnchor's TOOL_INDEX with new journal entries. Deduplicates by
 * tool_call_id (journal version wins because it carries the latest status).
 * Preserves chronological order: prior entries first, then new ones.
 */
export function merge(prior: ToolIndexEntry[], fresh: ToolIndexEntry[]): ToolIndexEntry[] {
  const freshIds = new Set(fresh.map((e) => e.tool_call_id))
  const carried = prior.filter((e) => !freshIds.has(e.tool_call_id))
  return [...carried, ...fresh]
}

/**
 * Render entries as a markdown TOOL_INDEX section. Returns the section text
 * including the `## TOOL_INDEX` header and a trailing newline.
 *
 * INV-6: caller is responsible for trimming `entries` to fit the budget
 * before calling; this function does not truncate.
 */
export function renderSection(entries: ToolIndexEntry[]): string {
  const lines = [
    SECTION_MARKER,
    "",
    "| tool_call_id | tool_name | args_brief | status | output_chars |",
    "|---|---|---|---|---|",
  ]
  if (entries.length === 0) {
    lines.push("| (no tool calls in this period) | — | — | — | 0 |")
  } else {
    for (const e of entries) {
      const cells = [
        e.tool_call_id,
        e.tool_name,
        e.args_brief.replace(/\|/g, "\\|"),
        e.status,
        String(e.output_chars),
      ]
      lines.push(`| ${cells.join(" | ")} |`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

/**
 * INV-6 size ceiling: trim entries so the rendered section is below
 * approximately maxBytes. Drops oldest entries first; appends a placeholder
 * row noting the truncation. Returns the trimmed array plus a truncatedCount.
 */
export function applyBudget(
  entries: ToolIndexEntry[],
  maxBytes: number,
): { entries: ToolIndexEntry[]; truncatedCount: number } {
  if (entries.length === 0) return { entries, truncatedCount: 0 }
  let trimmed = entries
  let truncated = 0
  while (trimmed.length > 0) {
    const rendered = renderSection(trimmed)
    if (Buffer.byteLength(rendered, "utf8") <= maxBytes) break
    trimmed = trimmed.slice(1)
    truncated += 1
  }
  if (truncated > 0) {
    const placeholder: ToolIndexEntry = {
      tool_call_id: `(truncated ${truncated} earlier entries — recall by guessing id from narrative)`,
      tool_name: "—",
      args_brief: "—",
      status: "unknown",
      output_chars: 0,
    }
    trimmed = [placeholder, ...trimmed]
  }
  return { entries: trimmed, truncatedCount: truncated }
}

/**
 * Build the prompt-side instruction that gets appended to the LLM compact
 * prompt. The instruction includes the precomputed TOOL_INDEX so the LLM
 * does not have to derive ids — only preserve them verbatim. This makes
 * compliance deterministic.
 */
export function buildPromptInstruction(precomputed: string): string {
  return [
    "",
    "TOOL_INDEX REQUIREMENT (compaction/recall-affordance L1):",
    "Your produced anchor body MUST END with the following ## TOOL_INDEX section,",
    "copied verbatim. Do not edit ids, change column order, or summarise rows.",
    "The narrative prose comes BEFORE this section; the section is the final",
    "block of the body. AI consumers of the next turn will use these ids with",
    "the `recall` tool to fetch the original tool outputs.",
    "",
    "BEGIN_TOOL_INDEX_VERBATIM",
    precomputed.trim(),
    "END_TOOL_INDEX_VERBATIM",
    "",
  ].join("\n")
}

/**
 * Validate that the persisted anchor body contains a parseable TOOL_INDEX
 * section. Used by defaultWriteAnchor post-write hook. Returns a summary
 * for telemetry.
 */
export function validate(body: string): {
  found: boolean
  entryCount: number
  indexBytes: number
} {
  const entries = parseFromBody(body)
  if (entries.length === 0) {
    // Check whether the marker is present at all — distinguishes "LLM ignored
    // the instruction" (false) from "LLM emitted marker but table is empty"
    // (true, entryCount=0).
    const found = findMarkerIndex(body) !== -1
    if (found) {
      log.info("tool_index.empty_table", { bodyChars: body.length })
    }
    return { found, entryCount: 0, indexBytes: 0 }
  }
  const indexBytes = (() => {
    const start = findMarkerIndex(body)
    if (start === -1) return 0
    return Buffer.byteLength(body.slice(start), "utf8")
  })()
  return { found: true, entryCount: entries.length, indexBytes }
}

export const TOOL_INDEX_SECTION_MARKER = SECTION_MARKER
