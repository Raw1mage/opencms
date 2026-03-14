import type { CommandOption } from "@/context/command"
import { batch } from "solid-js"
import type { Part } from "@opencode-ai/sdk/v2/client"
import type { SessionStatus, Todo, Message } from "@opencode-ai/sdk/v2/client"

export const focusTerminalById = (id: string) => {
  const wrapper = document.getElementById(`terminal-wrapper-${id}`)
  const terminal = wrapper?.querySelector('[data-component="terminal"]')
  if (!(terminal instanceof HTMLElement)) return false

  const textarea = terminal.querySelector("textarea")
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.focus()
    return true
  }

  terminal.focus()
  terminal.dispatchEvent(
    typeof PointerEvent === "function"
      ? new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      : new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
  )
  return true
}

export const createOpenReviewFile = (input: {
  showAllFiles: () => void
  tabForPath: (path: string) => string
  openTab: (tab: string) => void
  setActive: (tab: string) => void
  loadFile: (path: string) => void | Promise<void>
}) => {
  return (path: string) => {
    batch(() => {
      input.showAllFiles()
      const maybePromise = input.loadFile(path)
      const open = () => {
        const tab = input.tabForPath(path)
        input.openTab(tab)
        input.setActive(tab)
      }
      if (maybePromise instanceof Promise) maybePromise.then(open)
      else open()
    })
  }
}

export const combineCommandSections = (sections: readonly (readonly CommandOption[])[]) => {
  return sections.flatMap((section) => section)
}

export const getTabReorderIndex = (tabs: readonly string[], from: string, to: string) => {
  const fromIndex = tabs.indexOf(from)
  const toIndex = tabs.indexOf(to)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return undefined
  return toIndex
}

type WorkflowChipTone = "neutral" | "info" | "success" | "warning"

export type AutonomousHealthSummary = {
  state: string
  stopReason?: string
  queue: {
    hasPendingContinuation: boolean
    roundCount?: number
    reason?: string
    queuedAt?: number
  }
  supervisor: {
    leaseOwner?: string
    leaseExpiresAt?: number
    retryAt?: number
    consecutiveResumeFailures: number
    lastResumeCategory?: string
    lastResumeError?: string
  }
  anomalies: {
    recentCount: number
    latestEventType?: string
    latestAt?: number
    flags: string[]
    countsByType: Record<string, number>
  }
  summary: {
    health: "healthy" | "queued" | "paused" | "degraded" | "blocked" | "completed"
    label: string
  }
}

export type SessionWorkflowChip = {
  label: string
  tone: WorkflowChipTone
}

type ModelArbitrationTrace = {
  agentName?: string
  domain?: string
  selected?: {
    providerId?: string
    modelID?: string
    source?: string
  }
}

type WorkflowLikeSession = {
  workflow?: {
    autonomous?: {
      enabled?: boolean
    }
    state?: string
    stopReason?: string
    supervisor?: {
      leaseOwner?: string
      retryAt?: number
      consecutiveResumeFailures?: number
      lastResumeCategory?: string
      lastResumeError?: string
      lastGovernorTraceAt?: number
      lastGovernorTrace?: {
        status?: string
        deterministicReason?: string
        assessment?: string
        assist?: {
          enabled?: boolean
          applied?: boolean
          mode?: string
        }
        suggestion?: {
          kind?: string
          reason?: string
          suggestedTodoID?: string
          suggestedAction?: string
          draftQuestion?: string
          askUserHandoff?: {
            question?: string
            whyNow?: string
            blockingDecision?: string
            impactIfUnanswered?: string
          }
          askUserAdoption?: {
            proposalID?: string
            proposedQuestion?: string
            targetTodoID?: string
            rationale?: string
            adoptionNote?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
            hostAdopted?: boolean
            hostAdoptionReason?: string
          }
          approvalRequest?: {
            proposalID?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
            hostAdopted?: boolean
            hostAdoptionReason?: string
          }
          riskPauseRequest?: {
            proposalID?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
            hostAdopted?: boolean
            hostAdoptionReason?: string
          }
          completionRequest?: {
            proposalID?: string
            completionScope?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
            hostAdopted?: boolean
            hostAdoptionReason?: string
          }
          pauseRequest?: {
            rationale?: string
            pauseScope?: string
            advisoryNote?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
          }
          replanRequest?: {
            targetTodoID?: string
            requestedAction?: string
            proposedNextStep?: string
            note?: string
          }
          replanAdoption?: {
            proposalID?: string
            targetTodoID?: string
            proposedAction?: string
            proposedNextStep?: string
            rationale?: string
            adoptionNote?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
            hostAdopted?: boolean
            hostAdoptionReason?: string
          }
        }
        decision?: {
          decision?: string
          confidence?: string
          nextAction?: {
            kind?: string
            narration?: string
          }
        }
      }
      governorTraceHistory?: Array<{
        createdAt?: number
        status?: string
        deterministicReason?: string
        assessment?: string
        assist?: {
          enabled?: boolean
          applied?: boolean
          mode?: string
        }
        suggestion?: {
          kind?: string
          reason?: string
          suggestedTodoID?: string
          suggestedAction?: string
          draftQuestion?: string
          askUserHandoff?: {
            question?: string
            whyNow?: string
            blockingDecision?: string
            impactIfUnanswered?: string
          }
          askUserAdoption?: {
            proposalID?: string
            proposedQuestion?: string
            targetTodoID?: string
            rationale?: string
            adoptionNote?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
            hostAdopted?: boolean
            hostAdoptionReason?: string
          }
          approvalRequest?: {
            proposalID?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
            hostAdopted?: boolean
            hostAdoptionReason?: string
          }
          riskPauseRequest?: {
            proposalID?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
            hostAdopted?: boolean
            hostAdoptionReason?: string
          }
          completionRequest?: {
            proposalID?: string
            completionScope?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
            hostAdopted?: boolean
            hostAdoptionReason?: string
          }
          pauseRequest?: {
            rationale?: string
            pauseScope?: string
            advisoryNote?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
          }
          replanRequest?: {
            targetTodoID?: string
            requestedAction?: string
            proposedNextStep?: string
            note?: string
          }
          replanAdoption?: {
            proposalID?: string
            targetTodoID?: string
            proposedAction?: string
            proposedNextStep?: string
            rationale?: string
            adoptionNote?: string
            policy?: {
              trustLevel?: string
              adoptionMode?: string
              requiresUserConfirm?: boolean
              requiresHostReview?: boolean
            }
            hostAdopted?: boolean
            hostAdoptionReason?: string
          }
        }
        decision?: {
          decision?: string
          confidence?: string
          nextAction?: {
            kind?: string
            narration?: string
          }
        }
        error?: string
      }>
    }
  }
}

const prettyWorkflowState = (state?: string) => {
  if (!state) return undefined
  if (state === "waiting_user") return "Waiting"
  if (state === "blocked") return "Blocked"
  if (state === "completed") return "Completed"
  return state.charAt(0).toUpperCase() + state.slice(1)
}

const prettyStopReason = (reason?: string) => {
  if (!reason) return undefined
  const normalized = reason.replace(/^resume_failed:/, "resume failed: ").replaceAll("_", " ")
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

export const getSessionWorkflowChips = (session?: WorkflowLikeSession): SessionWorkflowChip[] => {
  const workflow = session?.workflow
  if (!workflow) return []

  const chips: SessionWorkflowChip[] = []
  if (workflow.autonomous?.enabled) {
    chips.push({ label: "Auto", tone: "info" })
    chips.push({ label: "Model auto", tone: "info" })
  }

  const state = prettyWorkflowState(workflow.state)
  if (state) {
    const tone: WorkflowChipTone =
      workflow.state === "completed"
        ? "success"
        : workflow.state === "blocked"
          ? "warning"
          : workflow.state === "running"
            ? "info"
            : "neutral"
    chips.push({ label: state, tone })
  }

  const reason = prettyStopReason(workflow.stopReason)
  if (reason) {
    chips.push({ label: reason, tone: workflow.state === "blocked" ? "warning" : "neutral" })
  }

  return chips
}

const formatArbitrationSource = (source?: string) => {
  if (!source) return undefined
  if (source === "agent_pinned") return "agent pinned"
  if (source === "rotation_rescue") return "rotation rescue"
  if (source === "session_previous") return "previous model"
  if (source === "fallback_forced") return "forced fallback"
  return source.replaceAll("_", " ")
}

const readArbitrationTrace = (part?: Part): ModelArbitrationTrace | undefined => {
  if (!part) return undefined
  if (part.type === "text") return part.metadata?.modelArbitration as ModelArbitrationTrace | undefined
  if (part.type === "tool") return part.metadata?.modelArbitration as ModelArbitrationTrace | undefined
  return undefined
}

export const getSessionArbitrationChips = (input: {
  userParts?: readonly Part[]
  toolParts?: readonly Part[]
}): SessionWorkflowChip[] => {
  const traces = [...(input.userParts ?? []), ...(input.toolParts ?? [])]
    .map((part) => readArbitrationTrace(part))
    .filter(Boolean) as ModelArbitrationTrace[]
  const trace = traces.at(-1)
  if (!trace?.selected?.providerId || !trace.selected.modelID) return []

  const chips: SessionWorkflowChip[] = [
    { label: `${trace.selected.providerId}/${trace.selected.modelID}`, tone: "neutral" },
  ]
  const source = formatArbitrationSource(trace.selected.source)
  if (source) chips.unshift({ label: source, tone: "info" })
  return chips
}

type TodoWithAction = Todo & {
  action?: {
    kind?: string
    risk?: string
    needsApproval?: boolean
    canDelegate?: boolean
    waitingOn?: string
  }
}

type TodoActionLike = TodoWithAction["action"]

export const formatTodoActionLabel = (action?: TodoActionLike) => {
  if (!action?.kind) return undefined
  if (action.kind === "architecture_change") return "architecture"
  if (action.kind === "destructive") return "destructive"
  if (action.kind === "approval") return "approval"
  if (action.kind === "decision") return "decision"
  return action.kind.replaceAll("_", " ")
}

export const formatTodoWaitingLabel = (action?: TodoActionLike) => {
  if (!action?.waitingOn) return undefined
  return `waiting: ${action.waitingOn}`
}

export type SessionStatusSummary = {
  currentStep?: TodoWithAction
  methodChips: SessionWorkflowChip[]
  processLines: string[]
}

type PartsByMessage = Record<string, readonly Part[] | undefined>

const formatDebugTime = (value: number) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (part: number) => part.toString().padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export const getSessionStatusSummary = (input: {
  session?: WorkflowLikeSession
  todos?: readonly Todo[]
  status?: SessionStatus
  messages?: readonly Message[]
  partsByMessage?: PartsByMessage
  autonomousHealth?: AutonomousHealthSummary
}): SessionStatusSummary => {
  const todos = (input.todos ?? []) as TodoWithAction[]
  const currentStep =
    todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending")
  const methodChips: SessionWorkflowChip[] = []
  const actionLabel = formatTodoActionLabel(currentStep?.action)
  if (actionLabel) methodChips.push({ label: actionLabel, tone: "info" })
  const waitingLabel = formatTodoWaitingLabel(currentStep?.action)
  if (waitingLabel) methodChips.push({ label: waitingLabel, tone: "neutral" })
  if (currentStep?.action?.needsApproval) methodChips.push({ label: "needs approval", tone: "warning" })
  if (currentStep?.action?.canDelegate) methodChips.push({ label: "delegable", tone: "info" })

  const processLines: string[] = []
  const workflowState = prettyWorkflowState(input.session?.workflow?.state)
  if (workflowState) processLines.push(`Workflow: ${workflowState}`)
  const stopReason = prettyStopReason(input.session?.workflow?.stopReason)
  if (stopReason) processLines.push(`Stop: ${stopReason}`)
  if (input.status?.type && input.status.type !== "idle") processLines.push(`Runtime: ${input.status.type}`)
  if (input.autonomousHealth?.summary?.label) processLines.push(`Health: ${input.autonomousHealth.summary.label}`)

  if (input.autonomousHealth?.queue.hasPendingContinuation) {
    processLines.push(
      `Queue: ${input.autonomousHealth.queue.reason?.replaceAll("_", " ") ?? "pending continuation"}${typeof input.autonomousHealth.queue.roundCount === "number" ? ` (round ${input.autonomousHealth.queue.roundCount})` : ""}`,
    )
  }
  if ((input.autonomousHealth?.anomalies.recentCount ?? 0) > 0) {
    processLines.push(`Anomalies: ${input.autonomousHealth?.anomalies.recentCount}`)
    if (input.autonomousHealth?.anomalies.latestEventType) {
      processLines.push(`Latest anomaly: ${input.autonomousHealth.anomalies.latestEventType}`)
    }
  }
  const supervisor = input.session?.workflow?.supervisor
  if (supervisor?.leaseOwner) processLines.push(`Lease: ${supervisor.leaseOwner}`)
  if (supervisor?.retryAt) processLines.push(`Retry at: ${formatDebugTime(supervisor.retryAt)}`)
  if ((supervisor?.consecutiveResumeFailures ?? 0) > 0)
    processLines.push(`Resume failures: ${supervisor?.consecutiveResumeFailures}`)
  if (supervisor?.lastResumeCategory) processLines.push(`Last category: ${supervisor.lastResumeCategory}`)
  if (supervisor?.lastResumeError) processLines.push(`Last error: ${supervisor.lastResumeError.slice(0, 120)}`)

  return {
    currentStep,
    methodChips,
    processLines,
  }
}
