/**
 * ANTML tool-call salvage.
 *
 * Background (incident 2026-05-30, ses_189df799…): claude-opus-4-8, when driven
 * via the claude-cli impersonation, intermittently emits tool calls in its
 * INNATE Claude-Code text format —
 *
 *   <invoke name="mcp__bash">
 *   <parameter name="command">…</parameter>
 *   </invoke>
 *
 * — inside a normal `text` content block instead of as a structured `tool_use`
 * block. opencode only parses native `tool_use`, so these leaked as plain text:
 * the tool never executed, finish came back as `stop`, and the model then
 * HALLUCINATED the result and continued. Native (structured) tool calls work
 * fine; the failure is format-only. opencode does NOT teach this format — it is
 * the model's trained habit (verified: no `<invoke>` in any opencode prompt).
 *
 * This module salvages those leaked calls: scan a finished text block, and for
 * every well-formed `<invoke>…</invoke>` recover a tool call. The caller maps
 * the name through `stripToolPrefix` (the leaked name is the already-prefixed
 * wire name, e.g. `mcp__bash`, so it round-trips exactly like a real tool_use
 * name) and re-emits a proper tool-call stream part.
 *
 * Conservative by construction: only fully-closed `<invoke>…</invoke>` pairs
 * match, so a truncated/partial emission is left as text (no half tool calls).
 * The `antml:` namespace prefix is optional (the model emits both forms).
 */

export interface SalvagedCall {
  /** Raw tool name as emitted (still TOOL_PREFIX-prefixed; caller strips it). */
  name: string
  /** Parameters serialized as a JSON object string, ready for `tool-call.input`. */
  input: string
}

const INVOKE_RE = /<(?:antml:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?invoke>/g
const PARAM_RE = /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?parameter>/g

/** Cheap pre-check so the hot streaming path pays nothing on normal text. */
export function mayContainAntmlInvoke(text: string | undefined): boolean {
  return !!text && (text.includes("<invoke") || text.includes(":invoke"))
}

/**
 * Parse all well-formed `<invoke>` blocks out of a text body.
 * Returns one SalvagedCall per invoke; empty array when none/partial.
 */
export function salvageAntmlInvokes(text: string | undefined): SalvagedCall[] {
  if (!mayContainAntmlInvoke(text)) return []
  const out: SalvagedCall[] = []
  INVOKE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INVOKE_RE.exec(text!)) !== null) {
    const name = m[1]!
    const body = m[2] ?? ""
    const params: Record<string, string> = {}
    PARAM_RE.lastIndex = 0
    let p: RegExpExecArray | null
    while ((p = PARAM_RE.exec(body)) !== null) {
      // Trim a single leading/trailing newline the model usually inserts around
      // the value, but preserve internal whitespace (e.g. multi-line commands).
      params[p[1]!] = (p[2] ?? "").replace(/^\n/, "").replace(/\n$/, "")
    }
    out.push({ name, input: JSON.stringify(params) })
  }
  return out
}
