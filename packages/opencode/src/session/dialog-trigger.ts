import type { Session } from "."
import type { MessageV2 } from "./message-v2"

/**
 * Dialog-trigger was a keyword-regex layer that pre-emptively routed user
 * prompts to plan/build agents or set stopReasons. Removed 2026-04-18 as
 * part of the "no hardcoded heuristics" cleanup — agent routing is now an
 * explicit user choice in the TUI; runloop / AI decides everything else.
 *
 * The type surface is kept (with every decision collapsed to "none") so
 * existing callers continue to compile unchanged.
 */

export type DialogTriggerName = "plan_enter" | "replan" | "approval"

export type DialogTriggerDecision = {
  trigger: DialogTriggerName | "none"
  routeAgent?: "plan" | "build"
  suppressAutoEnterPlan: boolean
  stopReason?: "approval_needed" | "product_decision_needed"
}

export type DialogTriggerPolicy = {
  decision: DialogTriggerDecision
}

export function resolveDialogTrigger(_input: {
  agent?: string
  client: string
  parts: Array<{ type: string; text?: string }>
  session: Pick<Session.Info, "workflow" | "time">
}): DialogTriggerDecision {
  return {
    trigger: "none",
    suppressAutoEnterPlan: true,
  }
}

export async function resolveDialogTriggerPolicy(_input: {
  agent?: string
  client: string
  parts: Array<{ type: string; text?: string }>
  session: Pick<Session.Info, "workflow" | "time" | "slug" | "title">
}): Promise<DialogTriggerPolicy> {
  return {
    decision: {
      trigger: "none",
      suppressAutoEnterPlan: true,
    },
  }
}

// kept for compatibility with any out-of-tree imports
export type _Unused = MessageV2.Part
