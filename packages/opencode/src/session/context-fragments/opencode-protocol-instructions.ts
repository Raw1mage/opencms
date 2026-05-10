/**
 * OpencodeProtocolInstructions fragment — OpenCode-only.
 *
 * SYSTEM.md (OpenCode constitution) has no upstream codex-cli analog
 * (codex-cli ships its rules in `BaseInstructions`). OpenCode is
 * cross-provider; SYSTEM.md captures rules that span all providers
 * (Read-Before-Write, Absolute Paths, Working Cache, Code Review modes,
 * Presentation defaults, etc.).
 *
 * Per DD-3 (plans/provider_codex-prompt-realign):
 *   - ROLE: developer (same semantic layer as PermissionsInstructions /
 *     AppsInstructions — "behavioral rules" not "environment / identity /
 *     input")
 *   - START_MARKER: <opencode_protocol> (style mirrors upstream
 *     <permissions instructions> and similar tagged blocks)
 *   - body: SYSTEM.md text verbatim, joined by `\n` when multiple
 *     SYSTEM.md sources exist
 *
 * Producer feeds in already-loaded SYSTEM.md content (typically from
 * `SystemPrompt.system(isSubagent)` in session/system.ts). The fragment
 * does not own the file load — keeps producer/loader concerns separate.
 */

import type { ContextFragment } from "./fragment"

export const OPENCODE_PROTOCOL_OPEN_TAG = "<opencode_protocol>"
export const OPENCODE_PROTOCOL_CLOSE_TAG = "</opencode_protocol>"

export interface OpencodeProtocolInput {
  /** Already-loaded SYSTEM.md text (full file contents). */
  text: string
}

export function buildOpencodeProtocolFragment(input: OpencodeProtocolInput): ContextFragment {
  return {
    id: "opencode_protocol",
    role: "developer",
    startMarker: OPENCODE_PROTOCOL_OPEN_TAG,
    endMarker: OPENCODE_PROTOCOL_CLOSE_TAG,
    body: input.text,
    source: "opencode-only",
  }
}
