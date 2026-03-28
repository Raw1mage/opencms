import { Session } from "."
import type { MessageV2 } from "./message-v2"

export type DialogTriggerName = "plan_enter" | "replan" | "approval"

export type DialogTriggerDecision = {
  trigger: DialogTriggerName | "none"
  routeAgent?: "plan" | "build"
  suppressAutoEnterPlan: boolean
  stopReason?: "approval_needed" | "product_decision_needed"
}

export type DialogTriggerPolicy = {
  decision: DialogTriggerDecision
  autoPlanExitHandoff: boolean
}

export type PlannerIntent = "plan_enter" | "plan_exit"

const SUPPORTED_CLIENTS = ["app", "cli", "desktop"] as const

const PLAN_ENTER_HARD_NEGATIVE_PATTERNS = [
  /\bplan_exit\b/,
  /\bgo on plan_exit\b/,
  /\bexit plan mode\b/,
  /\bswitch to build mode\b/,
  /\bstart executing (it|the plan)\b/,
  /\bbuild mode\b/,
  /\bwhat did we do so far\b/,
  /\bstatus update\b/,
  /\bsummarize\b/,
  /\bsummary\b/,
  /\bexplain\b/,
  /\bjust answer\b/,
  /目前進度/,
  /做了什麼/,
  /總結一下/,
  /只要說明/,
  /退出 plan mode/,
  /離開 plan mode/,
  /切到 build mode/,
  /執行 plan_exit/,
] as const

const PLAN_ENTER_INTENT_KEYWORDS = [
  "implement",
  "build",
  "refactor",
  "debug",
  "fix",
  "investigate",
  "design",
  "architecture",
  "autonomous",
  "automation",
  "daemon",
  "spec",
  "multi-step",
  "continue work",
  "continue working",
  "subagent",
  "planner",
  "workflow",
  "需求",
  "規劃",
  "計畫",
  "實作",
  "重構",
  "除錯",
  "修復",
  "架構",
  "自治",
  "自動",
  "持續工作",
] as const

const PLAN_ENTER_COMPLEXITY_KEYWORDS = [
  "scope",
  "validation",
  "phases",
  "checkpoints",
  "handoff",
  "todo",
  "requirements",
  "constraints",
  "risk",
  "驗證",
  "階段",
  "檢查點",
  "交接",
  "任務",
  "限制",
  "風險",
] as const

const REPLAN_PATTERNS = [
  /\breplan\b/,
  /\bre-planning\b/,
  /\brework the plan\b/,
  /\bchange (the )?plan\b/,
  /\bchange direction\b/,
  /\bchanged requirements\b/,
  /重新規劃/,
  /重規劃/,
  /改計畫/,
  /改方向/,
  /需求變更/,
] as const

const REPLAN_DIRECTION_CHANGE_PATTERNS = [
  /\bchange direction\b/,
  /\bchanged requirements\b/,
  /\brework the plan\b/,
  /\bchange (the )?plan\b/,
  /改方向/,
  /需求變更/,
  /改計畫/,
] as const

const APPROVAL_PATTERNS = [
  /\bapprove\b/,
  /\bapproved\b/,
  /\bgo ahead\b/,
  /\bship it\b/,
  /\byes proceed\b/,
  /批准/,
  /核准/,
  /同意/,
  /准許/,
] as const

function normalizePromptText(parts: MessageV2.Part[] | Array<{ type: string; text?: string }>) {
  return parts
    .filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
    .toLowerCase()
}

function detectPlanEnter(text: string) {
  if (!text) return false
  if (PLAN_ENTER_HARD_NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return false

  const hasIntentKeyword = PLAN_ENTER_INTENT_KEYWORDS.some((keyword) => text.includes(keyword))
  const hasComplexityKeyword = PLAN_ENTER_COMPLEXITY_KEYWORDS.some((keyword) => text.includes(keyword))
  const lineCount = text.split(/\n+/).filter(Boolean).length
  const longEnough = text.length >= 80 || lineCount >= 3

  let score = 0
  if (hasIntentKeyword) score += 2
  if (hasComplexityKeyword) score += 2
  if (longEnough) score += 1
  if (/\b(plan|planner|planning)\b|規劃|計畫/.test(text)) score += 1

  return score >= 4
}

function detectReplan(text: string, session: Pick<Session.Info, "mission" | "workflow" | "time">) {
  if (!text) return false
  if (!session.mission?.executionReady) return false
  const workflow = session.workflow ?? Session.defaultWorkflow(session.time.updated)
  if (!["idle", "running", "waiting_user"].includes(workflow.state)) return false
  const hasReplanWording = REPLAN_PATTERNS.some((pattern) => pattern.test(text))
  if (!hasReplanWording) return false
  return REPLAN_DIRECTION_CHANGE_PATTERNS.some((pattern) => pattern.test(text))
}

function detectApproval(text: string, session: Pick<Session.Info, "workflow" | "time">) {
  if (!text) return false
  const workflow = session.workflow ?? Session.defaultWorkflow(session.time.updated)
  if (workflow.stopReason !== "approval_needed") return false
  return APPROVAL_PATTERNS.some((pattern) => pattern.test(text))
}

export function resolveDialogTrigger(input: {
  agent?: string
  client: string
  parts: Array<{ type: string; text?: string }>
  session: Pick<Session.Info, "mission" | "workflow" | "time">
  committedPlannerIntent?: PlannerIntent
}): DialogTriggerDecision {
  if (input.agent) {
    return {
      trigger: "none",
      suppressAutoEnterPlan: true,
    }
  }

  if (!SUPPORTED_CLIENTS.includes(input.client as (typeof SUPPORTED_CLIENTS)[number])) {
    return {
      trigger: "none",
      suppressAutoEnterPlan: true,
    }
  }

  if (input.committedPlannerIntent === "plan_exit") {
    return {
      trigger: "none",
      routeAgent: "build",
      suppressAutoEnterPlan: true,
    }
  }

  const text = normalizePromptText(input.parts)
  if (!text) {
    return {
      trigger: "none",
      suppressAutoEnterPlan: true,
    }
  }

  if (detectApproval(text, input.session)) {
    return {
      trigger: "approval",
      routeAgent: "build",
      suppressAutoEnterPlan: true,
      stopReason: "approval_needed",
    }
  }

  if (detectReplan(text, input.session)) {
    return {
      trigger: "replan",
      routeAgent: "plan",
      suppressAutoEnterPlan: false,
      stopReason: "product_decision_needed",
    }
  }

  if (detectPlanEnter(text)) {
    return {
      trigger: "plan_enter",
      routeAgent: "plan",
      suppressAutoEnterPlan: false,
    }
  }

  return {
    trigger: "none",
    suppressAutoEnterPlan: true,
  }
}

export async function resolveDialogTriggerPolicy(input: {
  agent?: string
  client: string
  parts: Array<{ type: string; text?: string }>
  session: Pick<Session.Info, "mission" | "workflow" | "time">
  committedPlannerIntent?: PlannerIntent
}): Promise<DialogTriggerPolicy> {
  return {
    decision: resolveDialogTrigger(input),
    autoPlanExitHandoff: false,
  }
}
