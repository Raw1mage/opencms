/**
 * EnvironmentContext fragment — upstream codex-cli alignment.
 *
 * Mirrors `refs/codex/codex-rs/core/src/context/environment_context.rs`.
 * Carries cwd / shell / current_date / timezone as a user-role wrapped
 * block. Shape is deliberately copied verbatim from upstream so prefix
 * cache prefixes line up with codex-cli's own.
 *
 * Format (single-environment case):
 *
 *   <environment_context>
 *     <cwd>{cwd}</cwd>
 *     <shell>{shell}</shell>
 *     <current_date>{current_date}</current_date>
 *     <timezone>{timezone}</timezone>
 *   </environment_context>
 *
 * Producer guarantees byte-stability across turns iff cwd / shell /
 * timezone / today's date all stable; current_date naturally rotates
 * once per local day (DD-2 of upstream design).
 */

import type { ContextFragment } from "./fragment"

export interface EnvironmentContextInput {
  cwd: string
  shell: string
  /** "Sun May 11 2026" form (or whatever caller standardizes). */
  currentDate: string
  /** IANA timezone string, e.g. "Asia/Taipei". Optional — upstream omits when missing. */
  timezone?: string
}

export const ENVIRONMENT_CONTEXT_OPEN_TAG = "<environment_context>"
export const ENVIRONMENT_CONTEXT_CLOSE_TAG = "</environment_context>"

export function buildEnvironmentContextFragment(input: EnvironmentContextInput): ContextFragment {
  const lines: string[] = []
  lines.push(`  <cwd>${input.cwd}</cwd>`)
  lines.push(`  <shell>${input.shell}</shell>`)
  lines.push(`  <current_date>${input.currentDate}</current_date>`)
  if (input.timezone) {
    lines.push(`  <timezone>${input.timezone}</timezone>`)
  }
  const body = `\n${lines.join("\n")}\n`
  return {
    id: "environment_context",
    role: "user",
    startMarker: ENVIRONMENT_CONTEXT_OPEN_TAG,
    endMarker: ENVIRONMENT_CONTEXT_CLOSE_TAG,
    body,
    source: "upstream",
  }
}
