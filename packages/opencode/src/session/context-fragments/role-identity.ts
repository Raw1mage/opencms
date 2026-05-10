/**
 * RoleIdentity fragment — OpenCode-only.
 *
 * OpenCode runs Main Agent and Subagent under the same wire structure;
 * upstream codex-cli has no such bifurcation, so this fragment has no
 * direct upstream analog. Per DD-8 (plans/provider_codex-prompt-realign):
 *
 *   - ROLE: developer (sits at the very front of the developer bundle —
 *     before OpencodeProtocolInstructions — so the Main vs Subagent
 *     distinction is the FIRST thing the model reads)
 *   - START_MARKER: <role_identity>
 *   - body:
 *       Current Role: <role>
 *       Session Context: <ctx>
 *
 * `role` is "Main Agent" or "Subagent"; `sessionContext` is "Main-task
 * Orchestration" or "Sub-task". Producer reads from `session.parentID`
 * (parent set ⇒ subagent).
 */

import type { ContextFragment } from "./fragment"

export const ROLE_IDENTITY_OPEN_TAG = "<role_identity>"
export const ROLE_IDENTITY_CLOSE_TAG = "</role_identity>"

export interface RoleIdentityInput {
  isSubagent: boolean
}

export function buildRoleIdentityFragment(input: RoleIdentityInput): ContextFragment {
  const role = input.isSubagent ? "Subagent" : "Main Agent"
  const ctx = input.isSubagent ? "Sub-task" : "Main-task Orchestration"
  const body = `\nCurrent Role: ${role}\nSession Context: ${ctx}\n`
  return {
    id: "role_identity",
    role: "developer",
    startMarker: ROLE_IDENTITY_OPEN_TAG,
    endMarker: ROLE_IDENTITY_CLOSE_TAG,
    body,
    source: "opencode-only",
  }
}
