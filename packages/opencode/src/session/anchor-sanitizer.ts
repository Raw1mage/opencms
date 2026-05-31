// Compaction anchor sanitizer (DD-6 of specs/prompt-cache-and-compaction-hardening).
//
// The anchor body is an assistant message inserted into the conversation
// history (`summary === true`). LLMs weight recent conversation heavily, so
// raw imperative text in an anchor competes with L7 SYSTEM.md authority.
// Two-layer defense:
//   1. wrap body in <prior_context source="{kind}">…</prior_context>
//   2. soften imperative-leading lines with a "Note from prior context: " prefix
//
// Pure string transform; byte-deterministic (same input → same output).

export type AnchorKind = "narrative" | "ai_free" | "ai_paid"

export interface SanitizedAnchorBody {
  wrapperOpen: string
  softenedBody: string
  wrapperClose: string
  /** True if at least one line was rewritten by the imperative softener. */
  imperativePrefixApplied: boolean
}

const WRAPPER_CLOSE = "</prior_context>"
const WRAPPER_RE = /^<prior_context\b[^>]*>\n?([\s\S]*?)\n?<\/prior_context>$/
const WRAPPER_OPEN_RE = /^<prior_context\b[^>]*>\n?/

const IMPERATIVE_LEADING = /^(You must|You should|Always|Never|Do not|Don't|Rules?:|Important:|System:)/i
const SOFT_PREFIX = "Note from prior context: "

export function sanitizeAnchor(text: string, kind: AnchorKind): SanitizedAnchorBody {
  const wrapperOpen = `<prior_context source="${kind}">`
  let imperativePrefixApplied = false
  const lines = unwrapPriorContext(text).split("\n")
  const softened = lines.map((line) => {
    if (IMPERATIVE_LEADING.test(line.trimStart())) {
      imperativePrefixApplied = true
      // preserve any leading whitespace so list/code indentation is kept
      const leading = line.match(/^\s*/)?.[0] ?? ""
      return `${leading}${SOFT_PREFIX}${line.trimStart()}`
    }
    return line
  })
  return {
    wrapperOpen,
    softenedBody: softened.join("\n"),
    wrapperClose: WRAPPER_CLOSE,
    imperativePrefixApplied,
  }
}

export function unwrapPriorContext(text: string): string {
  let current = text
  while (true) {
    const whole = WRAPPER_RE.exec(current)
    if (whole) {
      current = whole[1].replace(/^\n|\n$/g, "")
      continue
    }

    const open = WRAPPER_OPEN_RE.exec(current)
    if (!open) return current
    const start = open[0].length
    const end = current.indexOf(WRAPPER_CLOSE, start)
    if (end < 0) return current
    const inner = current.slice(start, end).replace(/^\n|\n$/g, "")
    const after = current.slice(end + WRAPPER_CLOSE.length).replace(/^\n?/, "")
    current = `${inner}${after ? `\n${after}` : ""}`
  }
}

/**
 * claude supersede framing (context/claude-refactor DD-9/DD-16, INV-4). On the
 * stateless claude path the anchor is re-sent every turn and competes with a
 * newer verbatim tail; the codex `<prior_context>` framing silently asserts
 * "this is the current state", so a stale anchor misleads. Mirror official
 * claude-cli's framing: declare the summary covers the EARLIER portion and that
 * later messages supersede it. Pure string, claude-gated — codex omits opts and
 * is byte-identical (INV-0). Content (narrative) is unchanged; only the frame.
 */
function supersedePreamble(coversUpTo?: string): string {
  const upto = coversUpTo ? ` (up to ${coversUpTo})` : ""
  return (
    `[This summarizes the EARLIER portion of this conversation${upto}. ` +
    `Messages that appear AFTER this block are more recent and authoritative — ` +
    `treat them as the current state and reconcile against them; do NOT assume ` +
    `this summary reflects anything that happened after it.]`
  )
}

/** Convenience: sanitize and return the joined body string ready for persistence. */
export function sanitizeAnchorToString(
  text: string,
  kind: AnchorKind,
  opts?: { claudeSupersede?: boolean; coversUpTo?: string },
): {
  body: string
  imperativePrefixApplied: boolean
} {
  const parts = sanitizeAnchor(text, kind)
  if (opts?.claudeSupersede) {
    const attr = opts.coversUpTo ? ` covers_up_to="${opts.coversUpTo}"` : ""
    const open = `<prior_context source="${kind}"${attr} superseded_by_recent="true">`
    return {
      body: `${open}\n${supersedePreamble(opts.coversUpTo)}\n${parts.softenedBody}\n${parts.wrapperClose}`,
      imperativePrefixApplied: parts.imperativePrefixApplied,
    }
  }
  return {
    body: `${parts.wrapperOpen}\n${parts.softenedBody}\n${parts.wrapperClose}`,
    imperativePrefixApplied: parts.imperativePrefixApplied,
  }
}
