/**
 * CommitmentDigest — capture + render helper.
 *
 * Captures the most recent mutation-class tool calls from a session's
 * message stream so the AI, on the other side of a chain reset, knows
 * "these actions are already done; don't redo them." Used by both
 * chain-init-notice and amnesia-notice fragments via the shared
 * `renderDigest` helper.
 *
 * Rules:
 *   - Mutation-class only (DD-2). Reads / greps / probes excluded.
 *   - Last 5 entries by completion time, chronological order in body.
 *   - Total rendered body ≤ ~1000 chars; per-entry args ≤ 80, output ≤ 60.
 *   - Scrub secrets per same rules as TOOL_INDEX (no tokens, no URLs
 *     with auth params, no env-var dumps).
 *   - Capture is best-effort: stream errors return null; caller (the
 *     procedure executor) treats null as "use sentinel marker" (DD-8).
 */

import { MessageV2 } from "../message-v2"
import { Log } from "../../util/log"

const log = Log.create({ service: "continuation.commitment-digest" })

// -------------------------------------------------------------------------
// Mutation-class tool classification
// -------------------------------------------------------------------------

/**
 * Allowlist of tool names that count as mutations of project / fs state.
 * Adding a new mutation tool: add the name here. Read-only tools
 * (read / grep / glob / list / find / etc.) intentionally absent.
 */
const MUTATION_TOOL_NAMES = new Set<string>([
  "apply_patch",
  "edit",
  "write",
  "move_file",
  "delete_file",
  // bash gets special-cased — only counts when the command performs
  // a write effect; see classifyBashAsMutation below.
])

/**
 * Bash command prefixes that indicate a write-effect. Conservative —
 * if any of these substrings appears in the command, the bash call
 * is treated as a mutation. Read-style invocations (curl GET, ls,
 * head, cat, grep, find, jq, awk) do NOT match and are excluded.
 *
 * The classifier is intentionally coarse: a digest entry that mistakes
 * a non-mutation for a mutation costs an extra "you don't need to redo
 * this" hint; the inverse (missing a real mutation) is the failure
 * mode we cannot afford.
 */
const BASH_WRITE_EFFECT_MARKERS = [
  ">",
  ">>",
  "mv ",
  "cp ",
  "rm ",
  "mkdir ",
  "rmdir ",
  "touch ",
  "ln ",
  "chmod ",
  "chown ",
  "sed -i",
  "awk -i",
  "tee ",
  "git commit",
  "git add",
  "git push",
  "git rm",
  "git mv",
  "git reset",
  "git restore",
  "npm install",
  "bun install",
  "yarn add",
  "pnpm add",
  "git stash",
  "patch ",
  // any package manager mutation
  "apt install",
  "apt-get install",
  "brew install",
  "cargo add",
  "cargo install",
  "pip install",
  "uv add",
]

export function classifyBashAsMutation(command: string | undefined): boolean {
  if (!command || typeof command !== "string") return false
  const trimmed = command.trim()
  // Treat redirects on right-side as mutation (e.g. `curl ... > foo`).
  // The marker scan handles `>` and `>>` directly.
  for (const marker of BASH_WRITE_EFFECT_MARKERS) {
    if (trimmed.includes(marker)) return true
  }
  return false
}

export function isMutationToolCall(part: MessageV2.ToolPart): boolean {
  if (MUTATION_TOOL_NAMES.has(part.tool)) return true
  if (part.tool === "bash") {
    const cmd = (part.state as { input?: Record<string, any> }).input?.command
    return classifyBashAsMutation(typeof cmd === "string" ? cmd : undefined)
  }
  return false
}

// -------------------------------------------------------------------------
// Digest types
// -------------------------------------------------------------------------

export interface CommitmentDigestEntry {
  call_id: string
  tool: string
  args_brief: string // ≤80 chars after truncation
  status: "completed" | "failed" | "partial"
  output_summary: string // ≤60 chars after truncation
  completed_at: number
}

export interface CommitmentDigest {
  entries: CommitmentDigestEntry[]
  bodyCharCount: number
  capturedAt: number
  sourceMessageCount: number
}

// -------------------------------------------------------------------------
// Capture
// -------------------------------------------------------------------------

const DEFAULT_MAX_ENTRIES = 5
const DEFAULT_MAX_MESSAGES_SCANNED = 50
const ARGS_BRIEF_LIMIT = 80
const OUTPUT_SUMMARY_LIMIT = 60
const BODY_CHAR_BUDGET = 1000

export interface CaptureOptions {
  maxEntries?: number
  maxMessagesScanned?: number
}

/**
 * Scan the session's message stream and return up to `maxEntries`
 * most-recent mutation-class tool calls, chronological order.
 *
 * Returns `null` on stream error or unrecoverable failure — callers
 * (the procedure executor) treat null as "use sentinel marker" per
 * DD-8 ordering invariant. Returns a digest with empty `entries`
 * when the stream is well-formed but contains no mutation calls.
 */
export async function captureDigest(
  sessionID: string,
  options: CaptureOptions = {},
): Promise<CommitmentDigest | null> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxScanned = options.maxMessagesScanned ?? DEFAULT_MAX_MESSAGES_SCANNED

  const collected: CommitmentDigestEntry[] = []
  let sourceMessageCount = 0

  try {
    for await (const message of MessageV2.stream(sessionID)) {
      sourceMessageCount++
      if (sourceMessageCount > maxScanned * 4) {
        // hard ceiling on scan length so we don't drag forever on
        // very long sessions; collected entries are the most recent
        // mutations by virtue of stream's chronological order.
        break
      }
      for (const part of message.parts ?? []) {
        if (part.type !== "tool") continue
        if (!isMutationToolCall(part)) continue
        const entry = renderToolPartAsEntry(part)
        if (entry) collected.push(entry)
      }
    }
  } catch (err) {
    log.info("commitment digest capture failed (using sentinel)", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  // Last N by chronological order (stream is oldest-first).
  const entries = collected.slice(-maxEntries)
  const rendered = renderDigest(entries)
  return {
    entries,
    bodyCharCount: rendered.length,
    capturedAt: Date.now(),
    sourceMessageCount,
  }
}

export function renderToolPartAsEntry(part: MessageV2.ToolPart): CommitmentDigestEntry | null {
  const state = part.state
  if (state.status !== "completed" && state.status !== "error") return null

  const status: CommitmentDigestEntry["status"] =
    state.status === "error" ? "failed" : "completed"

  const argsBrief = scrubSecrets(briefArgs(part.tool, state.input))
  const outputSummary =
    status === "completed"
      ? scrubSecrets(briefOutput(part.tool, (state as { output?: string }).output ?? ""))
      : scrubSecrets(briefError((state as { error?: string }).error ?? ""))

  return {
    call_id: part.callID,
    tool: part.tool,
    args_brief: truncate(argsBrief, ARGS_BRIEF_LIMIT),
    status,
    output_summary: truncate(outputSummary, OUTPUT_SUMMARY_LIMIT),
    completed_at: state.time.end,
  }
}

function briefArgs(tool: string, input: Record<string, any> | undefined): string {
  if (!input) return ""
  switch (tool) {
    case "apply_patch":
      // patch input is typically the full patch text; show first path
      return extractFirstPatchPath(input["input"] ?? input["patch"] ?? "") ?? "(patch)"
    case "edit":
    case "write":
      return String(input["filePath"] ?? input["path"] ?? "(no path)")
    case "move_file":
      return `${input["from"] ?? "?"} → ${input["to"] ?? "?"}`
    case "delete_file":
      return String(input["path"] ?? "(no path)")
    case "bash":
      return String(input["command"] ?? "(no command)")
    default:
      // generic fallback — show first scalar value found
      for (const v of Object.values(input)) {
        if (typeof v === "string") return v
      }
      return ""
  }
}

function extractFirstPatchPath(patchText: string): string | null {
  if (!patchText || typeof patchText !== "string") return null
  // matches: *** Update File: <path>   |   *** Add File: <path>   |   *** Delete File: <path>
  const m = patchText.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m)
  return m ? m[1].trim() : null
}

function briefOutput(tool: string, output: string): string {
  const trimmed = (output ?? "").trim()
  if (!trimmed) return ""
  switch (tool) {
    case "apply_patch":
      // typical: "Success. Updated the following files:\nM foo.md"
      if (trimmed.startsWith("Success")) return "✓ Success"
      return trimmed.split("\n")[0]
    case "bash":
      // grab the last non-empty line as a coarse signal
      const lines = trimmed.split("\n").filter((l) => l.trim().length > 0)
      return lines[lines.length - 1] ?? ""
    default:
      return trimmed.split("\n")[0]
  }
}

function briefError(err: string): string {
  return (err ?? "").split("\n")[0] ?? ""
}

// -------------------------------------------------------------------------
// Scrubbing (secrets, tokens, URLs with credentials)
// -------------------------------------------------------------------------

/**
 * Coarse scrubbing pass. Anything that looks like a secret marker gets
 * replaced with `<scrubbed>`. Same rules as TOOL_INDEX so the two
 * surfaces stay consistent.
 *
 * NOT a security boundary — the digest is destined for the AI's own
 * prompt, and the message store already holds the raw values. This
 * scrub exists to avoid surfacing secrets to compact-aware backends
 * that might cache or log the digest separately.
 */
function scrubSecrets(text: string): string {
  if (!text) return ""
  return text
    // OAuth-style bearer tokens / API keys
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_\-]{32,}\b/g, "<scrubbed>")
    // URLs with auth params
    .replace(/https?:\/\/[^\s]*[?&](?:token|key|api_key|auth)=[^\s&]+/gi, "<scrubbed-url>")
    // env-var-style assignments
    .replace(/\b(?:[A-Z_]{3,}_(?:TOKEN|KEY|SECRET|PASSWORD)=)[^\s]+/g, "$1<scrubbed>")
    // sk-/pk- prefixed keys
    .replace(/\b(?:sk|pk|ghp|gho|ghs|github_pat)_[A-Za-z0-9_]+/g, "<scrubbed>")
}

function truncate(text: string, limit: number): string {
  if (!text) return ""
  if (text.length <= limit) return text
  return text.slice(0, Math.max(0, limit - 1)) + "…"
}

// -------------------------------------------------------------------------
// Render
// -------------------------------------------------------------------------

/**
 * Render commitment digest entries as a prose body suitable for
 * inclusion in chain-init-notice or amnesia-notice fragments.
 *
 * Output shape (example):
 *
 *   Recent committed actions (you DID these, don't redo):
 *   - call_p1  apply_patch  enterprise_security_operation_analysis.md   ✓ Success
 *   - call_p2  apply_patch  foo/bar.ts                                   ✓ Success
 *   - call_b1  bash          git commit -m "feat: …"                    exit 0
 *
 * Always returns a non-null string even for empty input (returns the
 * empty-body marker). The caller decides whether to include it.
 */
export function renderDigest(entries: ReadonlyArray<CommitmentDigestEntry>): string {
  if (entries.length === 0) {
    return "  (no recent mutation-class actions recorded)\n"
  }
  const lines: string[] = ["  Recent committed actions (you DID these, don't redo):"]
  for (const e of entries) {
    const status = e.status === "completed" ? "✓" : e.status === "failed" ? "✗" : "~"
    lines.push(`  - ${e.call_id}  ${e.tool}  ${e.args_brief}  ${status} ${e.output_summary}`)
  }
  let body = lines.join("\n") + "\n"
  if (body.length > BODY_CHAR_BUDGET) {
    // Hard ceiling; preserve the header and as many entries as fit.
    body = body.slice(0, BODY_CHAR_BUDGET - 16) + "\n  …truncated\n"
  }
  return body
}

/** Sentinel rendering for when capture failed entirely (DD-8). */
export const COMMITMENT_DIGEST_SENTINEL = "  <commitment_digest_unavailable>\n"
