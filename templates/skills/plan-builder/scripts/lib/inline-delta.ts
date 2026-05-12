/**
 * Helpers for producing inline delta markers and section-level supersede tags
 * used by amend / revise / extend modes.
 *
 * These helpers produce the *suggested* Markdown edits. They do not attempt
 * automatic in-place editing of arbitrary artifacts — that is a judgment task
 * left to the LLM author. A script can call `supersededDecisionTag` /
 * `addedRequirementHeading` to generate the exact token strings that
 * validator / reviewer tooling will grep for.
 */

function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `[SUPERSEDED by DD-7 — reason]` marker */
export function supersededMarker(by: string, reason?: string): string {
  const suffix = reason ? ` — ${reason}` : ""
  return `[SUPERSEDED by ${by}${suffix}]`
}

/** Inline strikethrough replacement with superseded annotation (returns the replacement string). */
export function strikethroughWithSupersede(oldText: string, by: string): string {
  return `~~${oldText}~~ ${supersededMarker(by)}`
}

/**
 * Produce a fresh `### Requirement: Name (vN, ADDED YYYY-MM-DD)` heading.
 * When `supersedes` is provided, includes `[SUPERSEDES X]` suffix.
 */
export function addedRequirementHeading(
  name: string,
  version: number,
  supersedes?: string,
): string {
  const tag = supersedes ? ` [SUPERSEDES ${supersedes}]` : ""
  return `### Requirement: ${name} (v${version}, ADDED ${today()})${tag}`
}

/** `**DD-N** <text> (YYYY-MM-DD, amended from DD-M)` line for design.md Decisions section. */
export function amendedDecisionLine(id: string, text: string, amendedFrom?: string): string {
  const parens = amendedFrom
    ? `(${today()}, amended from ${amendedFrom})`
    : `(${today()})`
  return `- **${id}** ${text} ${parens}`
}

/** Produce a `[SUPERSEDED]` suffix for an existing Decision line. */
export function supersededDecisionSuffix(by: string, reason?: string): string {
  return ` ${supersededMarker(by, reason)}`
}

/**
 * Helper for CLI tooling: given a body and a bullet starting with `- **DD-3**`,
 * return the body with `[SUPERSEDED by DD-7 — reason]` appended to that line
 * if it is not already present. Leaves the body unchanged if DD-3 is missing.
 */
export function markDecisionSuperseded(
  body: string,
  decisionId: string,
  supersededBy: string,
  reason?: string,
): string {
  const lineRe = new RegExp(
    `(^[-*]\\s+\\*\\*${decisionId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\*\\*[^\\n]*?)(\\s*\\[SUPERSEDED[^\\]]*\\])?$`,
    "m",
  )
  const marker = supersededMarker(supersededBy, reason)
  return body.replace(lineRe, (match, prefix: string, existing?: string) => {
    if (existing) return match // already tagged; leave alone
    return `${prefix} ${marker}`
  })
}
