import type { CommandOption } from "@/context/command"
import { batch } from "solid-js"
import type { Part } from "@opencode-ai/sdk/v2/client"

const normalizeReviewPath = (input: string) => input.replaceAll("\\", "/").replace(/\/+$/, "")

const normalizeReviewBody = (input: string) => input.replaceAll("\r\n", "\n")

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

export const getSessionScopedDirtyDiffs = <
  TDiff extends { file: string },
  TMessage extends { summary?: { diffs?: readonly { file: string }[] } },
>(
  currentDiffs: readonly TDiff[],
  messages: readonly TMessage[],
  options?: { fallback?: "all" | "none" },
) => {
  const touched = new Set<string>()
  for (const message of messages) {
    for (const diff of message.summary?.diffs ?? []) {
      if (!diff.file) continue
      touched.add(normalizeReviewPath(diff.file))
    }
  }

  if (touched.size === 0) return options?.fallback === "none" ? [] : [...currentDiffs]
  return currentDiffs.filter((diff) => touched.has(normalizeReviewPath(diff.file)))
}

export const getStrictSessionScopedDirtyDiffs = <
  TDiff extends { file: string; after: string; status?: string },
  TMessage extends { summary?: { diffs?: readonly { file: string; after: string; status?: string }[] } },
>(
  currentDiffs: readonly TDiff[],
  messages: readonly TMessage[],
) => {
  const latestByFile = new Map<string, { after: string; status?: string }>()

  for (const message of messages) {
    for (const diff of message.summary?.diffs ?? []) {
      if (!diff.file) continue
      latestByFile.set(normalizeReviewPath(diff.file), {
        after: normalizeReviewBody(diff.after ?? ""),
        status: diff.status,
      })
    }
  }

  if (latestByFile.size === 0) return []

  return currentDiffs.filter((diff) => {
    const latest = latestByFile.get(normalizeReviewPath(diff.file))
    if (!latest) return false
    const sameStatus = (latest.status ?? "modified") === (diff.status ?? "modified")
    if (!sameStatus) return false
    return latest.after === normalizeReviewBody(diff.after ?? "")
  })
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
  if (part.type === "tool" && "metadata" in part.state)
    return part.state.metadata?.modelArbitration as ModelArbitrationTrace | undefined
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
