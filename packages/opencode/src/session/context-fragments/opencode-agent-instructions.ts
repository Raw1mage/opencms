/**
 * OpencodeAgentInstructions fragment — OpenCode-only.
 *
 * Carries OpenCode's agent-specific persona (`agent.prompt`) plus any
 * runtime-injected `user.system` text. Upstream codex-cli has no
 * direct analog because it ships a single agent (codex CLI). OpenCode
 * runs many agents (build / plan / review / ...) under one provider
 * adapter, so we need a place for the agent-specific overlay that's
 * NOT the driver persona.
 *
 * Per DD-3 family decision (plans/provider_codex-prompt-realign):
 *   - ROLE: developer (same layer as OpencodeProtocolInstructions /
 *     PermissionsInstructions — "behavioral rules")
 *   - START_MARKER: <agent_instructions>
 *   - body: agent.prompt + (userSystem if present), joined by blank line
 *
 * Empty body (agent has no prompt AND no user.system) → fragment is
 * dropped by the assembler.
 */

import type { ContextFragment } from "./fragment"

export const AGENT_INSTRUCTIONS_OPEN_TAG = "<agent_instructions>"
export const AGENT_INSTRUCTIONS_CLOSE_TAG = "</agent_instructions>"

export interface OpencodeAgentInstructionsInput {
  /** Agent-specific persona prompt. Empty string if the agent has none. */
  agentPrompt: string
  /** Runtime-injected user.system text. Empty string if not set. */
  userSystem: string
}

export function buildOpencodeAgentInstructionsFragment(
  input: OpencodeAgentInstructionsInput,
): ContextFragment {
  const parts = [input.agentPrompt, input.userSystem].map((s) => s?.trim() ?? "").filter((s) => s.length > 0)
  const body = parts.join("\n\n")
  return {
    id: "agent_instructions",
    role: "developer",
    startMarker: AGENT_INSTRUCTIONS_OPEN_TAG,
    endMarker: AGENT_INSTRUCTIONS_CLOSE_TAG,
    body,
    source: "opencode-only",
  }
}
