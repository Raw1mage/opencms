/**
 * UserInstructions fragment — upstream codex-cli alignment.
 *
 * Mirrors `refs/codex/codex-rs/core/src/context/user_instructions.rs`:
 *
 *   const ROLE: &'static str = "user";
 *   const START_MARKER: &'static str = "# AGENTS.md instructions for ";
 *   const END_MARKER: &'static str = "</INSTRUCTIONS>";
 *
 *   fn body(&self) -> String {
 *       format!("{}\n\n<INSTRUCTIONS>\n{}\n", self.directory, self.text)
 *   }
 *
 * The full rendered fragment (per `renderFragment(f)`) is therefore:
 *
 *   # AGENTS.md instructions for <directory>
 *
 *   <INSTRUCTIONS>
 *   <text>
 *   </INSTRUCTIONS>
 *
 * OpenCode emits one fragment per AGENTS.md source (DD-4):
 *   - global: directory = "~/.config/opencode"
 *   - project: directory = <project root>
 *
 * Order: global first, project second.
 */

import type { ContextFragment } from "./fragment"

export interface UserInstructionsInput {
  /**
   * Disambiguator for OpenCode's two AGENTS.md sources. The fragment id
   * is composed as `agents_md:${scope}` to keep dedup deterministic.
   */
  scope: "global" | "project" | string
  /** Directory string surfaced to the model. Cosmetic only. */
  directory: string
  /** Contents of AGENTS.md (already loaded). */
  text: string
}

export const USER_INSTRUCTIONS_START_MARKER = "# AGENTS.md instructions for "
export const USER_INSTRUCTIONS_END_MARKER = "</INSTRUCTIONS>"

export function buildUserInstructionsFragment(input: UserInstructionsInput): ContextFragment {
  // Body shape from upstream user_instructions.rs:
  //   format!("{}\n\n<INSTRUCTIONS>\n{}\n", directory, text)
  // The directory string is the FIRST line; START_MARKER prefixes it.
  const body = `${input.directory}\n\n<INSTRUCTIONS>\n${input.text}\n`
  return {
    id: `agents_md:${input.scope}`,
    role: "user",
    startMarker: USER_INSTRUCTIONS_START_MARKER,
    endMarker: USER_INSTRUCTIONS_END_MARKER,
    body,
    source: "upstream",
  }
}
