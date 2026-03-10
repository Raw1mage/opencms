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
  debugLines: string[]
  smartRunnerSummary?: {
    total: number
    assistApplied: number
    assistNoop: number
    docsSync: number
    debugPreflight: number
    pauseAssist: number
    replan: number
    askUser: number
    requestApproval: number
    pauseForRisk: number
    complete: number
    pause: number
    adopted: number
    notAdopted: number
    nonAdoptedReasons: Array<{ reason: string; count: number }>
    recentTrend: string[]
  }
  smartRunnerHistory: Array<{
    time?: string
    status: string
    decision?: string
    confidence?: string
    next?: string
    assessment?: string
    assist?: string
    suggestion?: string
    draftQuestion?: string
    askUserHandoff?: string
    askUserAdoption?: string
    approvalRequest?: string
    riskPauseRequest?: string
    completionRequest?: string
    completionScope?: string
    pauseRequest?: string
    replanRequest?: string
    replanTarget?: string
    replanAdoption?: string
    policy?: string
    adoptionOutcome?: string
    error?: string
  }>
  latestNarration?: {
    label: string
    tone: SessionWorkflowChip["tone"]
  }
  smartRunnerConversation?: {
    totalNarrations: number
    pauseNarrations: number
    completeNarrations: number
    kindCounts: Array<{ kind: string; count: number }>
    latestKind?: string
    latestLabel?: string
  }
  latestResult?: {
    label: string
    tone: SessionWorkflowChip["tone"]
  }
}

type PartsByMessage = Record<string, readonly Part[] | undefined>

const summarizeTaskResult = (input: { messages?: readonly Message[]; partsByMessage?: PartsByMessage }) => {
  const messages = input.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    const parts = input.partsByMessage?.[message.id] ?? []
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex]
      if (part.type !== "tool" || part.tool !== "task") continue
      if (part.state.status === "completed") {
        const metadata = part.metadata as
          | { modelArbitration?: { selected?: { providerId?: string; modelID?: string } } }
          | undefined
        const model = metadata?.modelArbitration?.selected
        return {
          label: `Task completed${model?.providerId && model?.modelID ? ` · ${model.providerId}/${model.modelID}` : ""}`,
          tone: "success" as const,
        }
      }
      if (part.state.status === "error") {
        return {
          label: `Task blocked: ${part.state.error.slice(0, 120)}`,
          tone: "warning" as const,
        }
      }
      if (part.state.status === "running") {
        return {
          label: `Task running${part.state.input?.subagent_type ? ` · ${part.state.input.subagent_type}` : ""}`,
          tone: "info" as const,
        }
      }
    }
  }
}

const summarizeNarration = (input: { messages?: readonly Message[]; partsByMessage?: PartsByMessage }) => {
  const messages = input.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    const parts = input.partsByMessage?.[message.id] ?? []
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex]
      if (part.type !== "text") continue
      if (part.metadata?.autonomousNarration !== true) continue
      const kind = typeof part.metadata?.narrationKind === "string" ? part.metadata.narrationKind : undefined
      return {
        label: part.text,
        tone:
          kind === "pause" || kind === "interrupt"
            ? ("warning" as const)
            : kind === "complete"
              ? ("success" as const)
              : ("info" as const),
      }
    }
  }
}

const summarizeSmartRunnerConversation = (input: {
  messages?: readonly Message[]
  partsByMessage?: PartsByMessage
}) => {
  const messages = input.messages ?? []
  let totalNarrations = 0
  let pauseNarrations = 0
  let completeNarrations = 0
  const kindCounts = new Map<string, number>()
  let latestKind: string | undefined
  let latestLabel: string | undefined

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    const parts = input.partsByMessage?.[message.id] ?? []
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex]
      if (part.type !== "text") continue
      if (part.metadata?.autonomousNarration !== true) continue
      totalNarrations += 1
      const kind = typeof part.metadata?.narrationKind === "string" ? part.metadata.narrationKind : undefined
      if (kind === "pause" || kind === "interrupt") pauseNarrations += 1
      if (kind === "complete") completeNarrations += 1
      kindCounts.set(kind ?? "unknown", (kindCounts.get(kind ?? "unknown") ?? 0) + 1)
      if (!latestLabel) {
        latestKind = kind
        latestLabel = part.text
      }
    }
  }

  if (totalNarrations === 0) return undefined
  return {
    totalNarrations,
    pauseNarrations,
    completeNarrations,
    kindCounts: [...kindCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, count]) => ({ kind, count })),
    latestKind,
    latestLabel,
  }
}

const formatDebugTime = (value: number) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (part: number) => part.toString().padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const buildSmartRunnerSummary = (
  traces: Array<{
    decision?: { decision?: string }
    assist?: { enabled?: boolean; applied?: boolean; mode?: string }
    suggestion?: {
      kind?: string
      askUserAdoption?: { hostAdoptionReason?: string }
      replanAdoption?: { hostAdoptionReason?: string }
      approvalRequest?: { hostAdoptionReason?: string }
      riskPauseRequest?: { hostAdoptionReason?: string }
      completionRequest?: { hostAdoptionReason?: string }
      pauseRequest?: { advisoryNote?: string }
    }
  }>,
) => {
  if (traces.length === 0) return undefined
  const summary = {
    total: traces.length,
    assistApplied: 0,
    assistNoop: 0,
    docsSync: 0,
    debugPreflight: 0,
    pauseAssist: 0,
    replan: 0,
    askUser: 0,
    requestApproval: 0,
    pauseForRisk: 0,
    complete: 0,
    pause: 0,
    adopted: 0,
    notAdopted: 0,
    nonAdoptedReasons: [] as Array<{ reason: string; count: number }>,
    recentTrend: [] as string[],
  }
  const nonAdoptedReasonCounts = new Map<string, number>()

  for (const trace of traces) {
    if (trace.assist?.enabled) {
      if (trace.assist.applied) summary.assistApplied += 1
      else summary.assistNoop += 1
      if (trace.assist.mode === "docs_sync_first") summary.docsSync += 1
      if (trace.assist.mode === "debug_preflight_first") summary.debugPreflight += 1
      if (trace.assist.mode === "pause") summary.pauseAssist += 1
    }
    if (trace.suggestion?.kind === "replan") summary.replan += 1
    if (trace.suggestion?.kind === "ask_user") summary.askUser += 1
    if (trace.suggestion?.kind === "request_approval") summary.requestApproval += 1
    if (trace.suggestion?.kind === "pause_for_risk") summary.pauseForRisk += 1
    if (trace.suggestion?.kind === "complete") summary.complete += 1
    if (trace.suggestion?.kind === "pause") summary.pause += 1

    const adoptionReasons = [
      trace.suggestion?.askUserAdoption?.hostAdoptionReason,
      trace.suggestion?.replanAdoption?.hostAdoptionReason,
      trace.suggestion?.approvalRequest?.hostAdoptionReason,
      trace.suggestion?.riskPauseRequest?.hostAdoptionReason,
      trace.suggestion?.completionRequest?.hostAdoptionReason,
    ]
    for (const reason of adoptionReasons) {
      if (!reason) continue
      if (reason === "adopted") summary.adopted += 1
      else {
        summary.notAdopted += 1
        nonAdoptedReasonCounts.set(reason, (nonAdoptedReasonCounts.get(reason) ?? 0) + 1)
      }
    }
  }

  summary.nonAdoptedReasons = [...nonAdoptedReasonCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => ({ reason, count }))

  summary.recentTrend = traces.slice(-5).map((trace) => {
    const decision = trace.decision?.decision ?? "unknown"
    if (trace.suggestion?.kind) return `${decision} → ${trace.suggestion.kind}`
    if (trace.assist?.enabled) return `${decision} → ${trace.assist.applied ? (trace.assist.mode ?? "assist") : "noop"}`
    return decision
  })

  return summary
}

export const getSessionStatusSummary = (input: {
  session?: WorkflowLikeSession
  todos?: readonly Todo[]
  status?: SessionStatus
  messages?: readonly Message[]
  partsByMessage?: PartsByMessage
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

  const debugLines: string[] = []
  const supervisor = input.session?.workflow?.supervisor
  if (supervisor?.leaseOwner) debugLines.push(`Lease: ${supervisor.leaseOwner}`)
  if (supervisor?.retryAt) debugLines.push(`Retry at: ${formatDebugTime(supervisor.retryAt)}`)
  if ((supervisor?.consecutiveResumeFailures ?? 0) > 0)
    debugLines.push(`Resume failures: ${supervisor?.consecutiveResumeFailures}`)
  if (supervisor?.lastResumeCategory) debugLines.push(`Last category: ${supervisor.lastResumeCategory}`)
  if (supervisor?.lastResumeError) debugLines.push(`Last error: ${supervisor.lastResumeError.slice(0, 120)}`)
  if (supervisor?.lastGovernorTrace?.status) debugLines.push(`Governor: ${supervisor.lastGovernorTrace.status}`)
  if (supervisor?.lastGovernorTrace?.decision?.decision) {
    const confidence = supervisor.lastGovernorTrace.decision.confidence
    debugLines.push(
      `Governor decision: ${supervisor.lastGovernorTrace.decision.decision}${confidence ? ` (${confidence})` : ""}`,
    )
  }
  if (supervisor?.lastGovernorTrace?.decision?.nextAction?.kind) {
    debugLines.push(`Governor next: ${supervisor.lastGovernorTrace.decision.nextAction.kind}`)
  }
  if (supervisor?.lastGovernorTrace?.assist?.enabled) {
    debugLines.push(
      `Smart Runner assist: ${supervisor.lastGovernorTrace.assist.applied ? "applied" : "noop"}${supervisor.lastGovernorTrace.assist.mode ? ` (${supervisor.lastGovernorTrace.assist.mode})` : ""}`,
    )
  }
  if (supervisor?.lastGovernorTrace?.suggestion?.kind) {
    debugLines.push(
      `Smart Runner suggestion: ${supervisor.lastGovernorTrace.suggestion.kind}${supervisor.lastGovernorTrace.suggestion.suggestedAction ? ` (${supervisor.lastGovernorTrace.suggestion.suggestedAction})` : ""}`,
    )
    if (supervisor.lastGovernorTrace.suggestion.reason) {
      debugLines.push(
        `${
          supervisor.lastGovernorTrace.suggestion.kind === "ask_user"
            ? "Ask-user why"
            : supervisor.lastGovernorTrace.suggestion.kind === "replan"
              ? "Replan why"
              : supervisor.lastGovernorTrace.suggestion.kind === "request_approval"
                ? "Approval why"
                : supervisor.lastGovernorTrace.suggestion.kind === "pause_for_risk"
                  ? "Risk-pause why"
                  : supervisor.lastGovernorTrace.suggestion.kind === "complete"
                    ? "Complete why"
                    : supervisor.lastGovernorTrace.suggestion.kind === "pause"
                      ? "Pause why"
                      : "Suggestion why"
        }: ${supervisor.lastGovernorTrace.suggestion.reason.slice(0, 120)}`,
      )
    }
    if (
      supervisor.lastGovernorTrace.suggestion.kind === "ask_user" &&
      supervisor.lastGovernorTrace.suggestion.draftQuestion
    ) {
      debugLines.push(`Ask-user draft: ${supervisor.lastGovernorTrace.suggestion.draftQuestion.slice(0, 120)}`)
    }
    if (
      supervisor.lastGovernorTrace.suggestion.kind === "ask_user" &&
      supervisor.lastGovernorTrace.suggestion.askUserHandoff?.blockingDecision
    ) {
      debugLines.push(
        `Ask-user handoff: ${supervisor.lastGovernorTrace.suggestion.askUserHandoff.blockingDecision.slice(0, 120)}`,
      )
    }
    if (
      supervisor.lastGovernorTrace.suggestion.kind === "ask_user" &&
      supervisor.lastGovernorTrace.suggestion.askUserAdoption?.proposalID
    ) {
      debugLines.push(`Ask-user proposal: ${supervisor.lastGovernorTrace.suggestion.askUserAdoption.proposalID}`)
      if (supervisor.lastGovernorTrace.suggestion.askUserAdoption.policy?.adoptionMode) {
        debugLines.push(
          `Ask-user policy: ${supervisor.lastGovernorTrace.suggestion.askUserAdoption.policy.adoptionMode}${supervisor.lastGovernorTrace.suggestion.askUserAdoption.policy.trustLevel ? ` (${supervisor.lastGovernorTrace.suggestion.askUserAdoption.policy.trustLevel})` : ""}`,
        )
      }
      if (supervisor.lastGovernorTrace.suggestion.askUserAdoption.hostAdoptionReason) {
        debugLines.push(
          `Ask-user adoption: ${supervisor.lastGovernorTrace.suggestion.askUserAdoption.hostAdoptionReason.replaceAll("_", " ")}`,
        )
      }
    }
    if (
      supervisor.lastGovernorTrace.suggestion.kind === "request_approval" &&
      supervisor.lastGovernorTrace.suggestion.approvalRequest?.proposalID
    ) {
      debugLines.push(`Approval proposal: ${supervisor.lastGovernorTrace.suggestion.approvalRequest.proposalID}`)
      if (supervisor.lastGovernorTrace.suggestion.approvalRequest.policy?.adoptionMode) {
        debugLines.push(
          `Approval policy: ${supervisor.lastGovernorTrace.suggestion.approvalRequest.policy.adoptionMode}${supervisor.lastGovernorTrace.suggestion.approvalRequest.policy.trustLevel ? ` (${supervisor.lastGovernorTrace.suggestion.approvalRequest.policy.trustLevel})` : ""}`,
        )
      }
      if (supervisor.lastGovernorTrace.suggestion.approvalRequest.hostAdoptionReason) {
        debugLines.push(
          `Approval adoption: ${supervisor.lastGovernorTrace.suggestion.approvalRequest.hostAdoptionReason.replaceAll("_", " ")}`,
        )
      }
    }
    if (
      supervisor.lastGovernorTrace.suggestion.kind === "pause_for_risk" &&
      supervisor.lastGovernorTrace.suggestion.riskPauseRequest?.proposalID
    ) {
      debugLines.push(`Risk-pause proposal: ${supervisor.lastGovernorTrace.suggestion.riskPauseRequest.proposalID}`)
      if (supervisor.lastGovernorTrace.suggestion.riskPauseRequest.policy?.adoptionMode) {
        debugLines.push(
          `Risk-pause policy: ${supervisor.lastGovernorTrace.suggestion.riskPauseRequest.policy.adoptionMode}${supervisor.lastGovernorTrace.suggestion.riskPauseRequest.policy.trustLevel ? ` (${supervisor.lastGovernorTrace.suggestion.riskPauseRequest.policy.trustLevel})` : ""}`,
        )
      }
      if (supervisor.lastGovernorTrace.suggestion.riskPauseRequest.hostAdoptionReason) {
        debugLines.push(
          `Risk-pause adoption: ${supervisor.lastGovernorTrace.suggestion.riskPauseRequest.hostAdoptionReason.replaceAll("_", " ")}`,
        )
      }
    }
    if (
      supervisor.lastGovernorTrace.suggestion.kind === "complete" &&
      supervisor.lastGovernorTrace.suggestion.completionRequest?.proposalID
    ) {
      debugLines.push(`Complete proposal: ${supervisor.lastGovernorTrace.suggestion.completionRequest.proposalID}`)
      if (supervisor.lastGovernorTrace.suggestion.completionRequest.policy?.adoptionMode) {
        debugLines.push(
          `Complete policy: ${supervisor.lastGovernorTrace.suggestion.completionRequest.policy.adoptionMode}${supervisor.lastGovernorTrace.suggestion.completionRequest.policy.trustLevel ? ` (${supervisor.lastGovernorTrace.suggestion.completionRequest.policy.trustLevel})` : ""}`,
        )
      }
      if (supervisor.lastGovernorTrace.suggestion.completionRequest.hostAdoptionReason) {
        debugLines.push(
          `Complete adoption: ${supervisor.lastGovernorTrace.suggestion.completionRequest.hostAdoptionReason.replaceAll("_", " ")}`,
        )
      }
      if (supervisor.lastGovernorTrace.suggestion.completionRequest.completionScope) {
        debugLines.push(
          `Complete scope: ${supervisor.lastGovernorTrace.suggestion.completionRequest.completionScope.slice(0, 120)}`,
        )
      }
    }
    if (
      supervisor.lastGovernorTrace.suggestion.kind === "pause" &&
      supervisor.lastGovernorTrace.suggestion.pauseRequest?.pauseScope
    ) {
      debugLines.push(`Pause scope: ${supervisor.lastGovernorTrace.suggestion.pauseRequest.pauseScope}`)
      if (supervisor.lastGovernorTrace.suggestion.pauseRequest.policy?.adoptionMode) {
        debugLines.push(
          `Pause policy: ${supervisor.lastGovernorTrace.suggestion.pauseRequest.policy.adoptionMode}${supervisor.lastGovernorTrace.suggestion.pauseRequest.policy.trustLevel ? ` (${supervisor.lastGovernorTrace.suggestion.pauseRequest.policy.trustLevel})` : ""}`,
        )
      }
    }
    if (
      supervisor.lastGovernorTrace.suggestion.kind === "replan" &&
      supervisor.lastGovernorTrace.suggestion.replanRequest?.proposedNextStep
    ) {
      debugLines.push(
        `Replan request: ${supervisor.lastGovernorTrace.suggestion.replanRequest.proposedNextStep.slice(0, 120)}`,
      )
    }
    if (
      supervisor.lastGovernorTrace.suggestion.kind === "replan" &&
      supervisor.lastGovernorTrace.suggestion.replanAdoption?.proposalID
    ) {
      debugLines.push(
        `Replan proposal: ${supervisor.lastGovernorTrace.suggestion.replanAdoption.proposalID}${supervisor.lastGovernorTrace.suggestion.replanAdoption.hostAdopted ? " (adopted)" : ""}`,
      )
      if (supervisor.lastGovernorTrace.suggestion.replanAdoption.policy?.adoptionMode) {
        debugLines.push(
          `Replan policy: ${supervisor.lastGovernorTrace.suggestion.replanAdoption.policy.adoptionMode}${supervisor.lastGovernorTrace.suggestion.replanAdoption.policy.trustLevel ? ` (${supervisor.lastGovernorTrace.suggestion.replanAdoption.policy.trustLevel})` : ""}`,
        )
      }
      if (supervisor.lastGovernorTrace.suggestion.replanAdoption.hostAdoptionReason) {
        debugLines.push(
          `Replan adoption: ${supervisor.lastGovernorTrace.suggestion.replanAdoption.hostAdoptionReason.replaceAll("_", " ")}`,
        )
      }
      if (supervisor.lastGovernorTrace.suggestion.replanAdoption.targetTodoID) {
        debugLines.push(`Replan target: ${supervisor.lastGovernorTrace.suggestion.replanAdoption.targetTodoID}`)
      }
      if (supervisor.lastGovernorTrace.suggestion.replanAdoption.proposedAction) {
        debugLines.push(`Replan action: ${supervisor.lastGovernorTrace.suggestion.replanAdoption.proposedAction}`)
      }
    }
  }
  if (supervisor?.lastGovernorTraceAt)
    debugLines.push(`Governor at: ${formatDebugTime(supervisor.lastGovernorTraceAt)}`)

  const smartRunnerHistory = (supervisor?.governorTraceHistory ?? []).toReversed().map((trace) => ({
    time: trace.createdAt ? formatDebugTime(trace.createdAt) : undefined,
    status: trace.status ?? "unknown",
    decision: trace.decision?.decision,
    confidence: trace.decision?.confidence,
    next: trace.decision?.nextAction?.kind,
    assessment: trace.assessment,
    assist: trace.assist?.enabled
      ? `${trace.assist.applied ? "applied" : "noop"}${trace.assist.mode ? ` · ${trace.assist.mode}` : ""}`
      : undefined,
    suggestion: trace.suggestion?.kind
      ? `${trace.suggestion.kind}${trace.suggestion.suggestedAction ? ` · ${trace.suggestion.suggestedAction}` : ""}${trace.suggestion.reason ? ` · ${trace.suggestion.reason}` : ""}`
      : undefined,
    draftQuestion: trace.suggestion?.draftQuestion,
    askUserHandoff: trace.suggestion?.askUserHandoff?.blockingDecision,
    askUserAdoption: trace.suggestion?.askUserAdoption?.proposalID
      ? `${trace.suggestion.askUserAdoption.proposalID}${trace.suggestion.askUserAdoption.hostAdopted ? " · adopted" : ""}`
      : undefined,
    approvalRequest: trace.suggestion?.approvalRequest?.proposalID
      ? `${trace.suggestion.approvalRequest.proposalID}${trace.suggestion.approvalRequest.hostAdopted ? " · adopted" : ""}`
      : undefined,
    riskPauseRequest: trace.suggestion?.riskPauseRequest?.proposalID
      ? `${trace.suggestion.riskPauseRequest.proposalID}${trace.suggestion.riskPauseRequest.hostAdopted ? " · adopted" : ""}`
      : undefined,
    completionRequest: trace.suggestion?.completionRequest?.proposalID
      ? `${trace.suggestion.completionRequest.proposalID}${trace.suggestion.completionRequest.hostAdopted ? " · adopted" : ""}`
      : undefined,
    completionScope: trace.suggestion?.completionRequest?.completionScope,
    pauseRequest: trace.suggestion?.pauseRequest?.pauseScope,
    replanRequest: trace.suggestion?.replanRequest?.proposedNextStep,
    replanTarget: trace.suggestion?.replanAdoption?.targetTodoID
      ? `${trace.suggestion.replanAdoption.targetTodoID}${trace.suggestion.replanAdoption.proposedAction ? ` · ${trace.suggestion.replanAdoption.proposedAction}` : ""}`
      : undefined,
    replanAdoption: trace.suggestion?.replanAdoption?.proposalID
      ? `${trace.suggestion.replanAdoption.proposalID}${trace.suggestion.replanAdoption.hostAdopted ? " · adopted" : ""}`
      : undefined,
    policy: trace.suggestion?.askUserAdoption?.policy?.adoptionMode
      ? `${trace.suggestion.askUserAdoption.policy.adoptionMode}${trace.suggestion.askUserAdoption.policy.trustLevel ? ` · ${trace.suggestion.askUserAdoption.policy.trustLevel}` : ""}`
      : trace.suggestion?.approvalRequest?.policy?.adoptionMode
        ? `${trace.suggestion.approvalRequest.policy.adoptionMode}${trace.suggestion.approvalRequest.policy.trustLevel ? ` · ${trace.suggestion.approvalRequest.policy.trustLevel}` : ""}`
        : trace.suggestion?.riskPauseRequest?.policy?.adoptionMode
          ? `${trace.suggestion.riskPauseRequest.policy.adoptionMode}${trace.suggestion.riskPauseRequest.policy.trustLevel ? ` · ${trace.suggestion.riskPauseRequest.policy.trustLevel}` : ""}`
          : trace.suggestion?.completionRequest?.policy?.adoptionMode
            ? `${trace.suggestion.completionRequest.policy.adoptionMode}${trace.suggestion.completionRequest.policy.trustLevel ? ` · ${trace.suggestion.completionRequest.policy.trustLevel}` : ""}`
            : trace.suggestion?.pauseRequest?.policy?.adoptionMode
              ? `${trace.suggestion.pauseRequest.policy.adoptionMode}${trace.suggestion.pauseRequest.policy.trustLevel ? ` · ${trace.suggestion.pauseRequest.policy.trustLevel}` : ""}`
              : trace.suggestion?.replanAdoption?.policy?.adoptionMode
                ? `${trace.suggestion.replanAdoption.policy.adoptionMode}${trace.suggestion.replanAdoption.policy.trustLevel ? ` · ${trace.suggestion.replanAdoption.policy.trustLevel}` : ""}`
                : undefined,
    adoptionOutcome: trace.suggestion?.askUserAdoption?.hostAdoptionReason
      ? trace.suggestion.askUserAdoption.hostAdoptionReason === "adopted"
        ? "adopted"
        : `not adopted · ${trace.suggestion.askUserAdoption.hostAdoptionReason.replaceAll("_", " ")}`
      : trace.suggestion?.approvalRequest?.hostAdoptionReason
        ? trace.suggestion.approvalRequest.hostAdoptionReason === "adopted"
          ? "adopted"
          : `not adopted · ${trace.suggestion.approvalRequest.hostAdoptionReason.replaceAll("_", " ")}`
        : trace.suggestion?.riskPauseRequest?.hostAdoptionReason
          ? trace.suggestion.riskPauseRequest.hostAdoptionReason === "adopted"
            ? "adopted"
            : `not adopted · ${trace.suggestion.riskPauseRequest.hostAdoptionReason.replaceAll("_", " ")}`
          : trace.suggestion?.completionRequest?.hostAdoptionReason
            ? trace.suggestion.completionRequest.hostAdoptionReason === "adopted"
              ? "adopted"
              : `not adopted · ${trace.suggestion.completionRequest.hostAdoptionReason.replaceAll("_", " ")}`
            : trace.suggestion?.replanAdoption?.hostAdoptionReason
              ? trace.suggestion.replanAdoption.hostAdoptionReason === "adopted"
                ? "adopted"
                : `not adopted · ${trace.suggestion.replanAdoption.hostAdoptionReason.replaceAll("_", " ")}`
              : undefined,
    error: trace.error,
  }))
  const smartRunnerSummary = buildSmartRunnerSummary(supervisor?.governorTraceHistory ?? [])

  const latestTaskResult = summarizeTaskResult({ messages: input.messages, partsByMessage: input.partsByMessage })
  const latestNarration = summarizeNarration({ messages: input.messages, partsByMessage: input.partsByMessage })
  const smartRunnerConversation = summarizeSmartRunnerConversation({
    messages: input.messages,
    partsByMessage: input.partsByMessage,
  })
  if (smartRunnerConversation) {
    processLines.push(
      `AI layer: ${smartRunnerConversation.totalNarrations} narration${smartRunnerConversation.totalNarrations > 1 ? "s" : ""}`,
    )
    if (smartRunnerConversation.latestKind) processLines.push(`AI latest: ${smartRunnerConversation.latestKind}`)
  }
  const latestTodo = [...todos].reverse().find((todo) => todo.status === "completed" || todo.status === "cancelled")
  const latestResult =
    latestTaskResult ??
    (latestTodo
      ? {
          label: `${latestTodo.status === "completed" ? "Completed" : "Stopped"}: ${latestTodo.content}`,
          tone: latestTodo.status === "completed" ? ("success" as const) : ("warning" as const),
        }
      : undefined)

  return {
    currentStep,
    methodChips,
    processLines,
    debugLines,
    smartRunnerSummary,
    smartRunnerHistory,
    latestNarration,
    smartRunnerConversation,
    latestResult,
  }
}
