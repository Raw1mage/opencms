import { createSignal, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import type { CronJob, CronJobPatchInput, CronRunLogEntry, SessionMessage, SessionMessageWithParts } from "./api"
import { CronScheduleDisplay, formatRelativeTime } from "./cron-utils"
import { RunHistoryPanel } from "./run-history"

type CronApi = {
  getRuns(id: string, limit?: number): Promise<CronRunLogEntry[]>
  triggerJob(id: string): Promise<void>
  getSessionMessages(sessionId: string): Promise<SessionMessage[]>
  getSessionMessage(sessionId: string, messageId: string): Promise<SessionMessageWithParts>
}

export function TaskCard(props: {
  job: CronJob
  api: CronApi
  onDelete: () => void
  onToggle: () => void
  onTrigger: () => void
  onUpdate: (patch: CronJobPatchInput) => void
  onEdit: () => void
}) {
  const [testing, setTesting] = createSignal(false)

  const prompt = () => {
    const p = props.job.payload
    return p.kind === "agentTurn" ? p.message : p.kind === "systemEvent" ? p.text : ""
  }

  const statusColor = () => {
    if (!props.job.enabled) return "text-color-dimmed"
    const s = props.job.state.lastRunStatus
    if (s === "error") return "text-red-400"
    if (s === "ok") return "text-green-400"
    return "text-color-secondary"
  }

  const statusLabel = () => {
    if (!props.job.enabled) return "Disabled"
    if (props.job.state.runningAtMs) return "Running..."
    const s = props.job.state.lastRunStatus
    if (s === "error") return "Error"
    if (s === "ok") return "OK"
    return "Pending"
  }

  async function handleTest() {
    setTesting(true)
    try {
      await props.api.triggerJob(props.job.id)
    } catch {
      // trigger is fire-and-forget
    } finally {
      setTesting(false)
    }
  }

  return (
    <div
      classList={{
        "rounded-lg border bg-background-base overflow-hidden": true,
        "border-border-base": props.job.enabled,
        "border-border-weak-base opacity-60": !props.job.enabled,
      }}
    >
      {/* Header row */}
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-border-weak-base">
        <div class="flex items-center gap-2 min-w-0">
          <div classList={{ "w-2 h-2 rounded-full shrink-0": true, "bg-green-400": props.job.enabled, "bg-neutral-500": !props.job.enabled }} />
          <span class="text-14-semibold text-color-primary truncate">{props.job.name}</span>
          <Show when={props.job.description}>
            <span class="text-12-medium text-color-dimmed truncate">— {props.job.description}</span>
          </Show>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span classList={{ "text-11-medium": true, [statusColor()]: true }}>{statusLabel()}</span>
          <CronScheduleDisplay schedule={props.job.schedule} />
          <Show when={props.job.state.nextRunAtMs}>
            <span class="text-11-medium text-color-dimmed">
              Next: {formatRelativeTime(props.job.state.nextRunAtMs!)}
            </span>
          </Show>
        </div>
      </div>

      {/* Two-zone body: Prompt | Actions */}
      <div class="grid grid-cols-1 lg:grid-cols-[1fr_auto] divide-y lg:divide-y-0 lg:divide-x divide-border-weak-base">

        {/* Zone 1: Prompt (read-only, click to edit) */}
        <div class="p-3 min-h-[60px] cursor-pointer hover:bg-surface-raised-base-hover transition-colors" onClick={props.onEdit}>
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Prompt</span>
            <span class="text-11-medium text-accent-base">Edit</span>
          </div>
          <p class="text-13-medium text-color-secondary whitespace-pre-wrap break-words line-clamp-3">
            {prompt() || <span class="text-color-dimmed italic">No prompt set</span>}
          </p>
        </div>

        {/* Zone 2: Actions */}
        <div class="p-3 min-w-[180px]">
          <div class="flex flex-wrap gap-1.5">
            <Button size="small" variant={props.job.enabled ? "ghost" : "primary"} onClick={props.onToggle}>
              {props.job.enabled ? "Stop" : "Start"}
            </Button>
            <Button size="small" variant="ghost" onClick={handleTest} disabled={testing()}>
              {testing() ? "Running..." : "Test"}
            </Button>
            <Button size="small" variant="ghost" class="text-red-400 hover:text-red-300" onClick={props.onDelete}>
              Delete
            </Button>
          </div>
          <Show when={props.job.state.consecutiveErrors && props.job.state.consecutiveErrors > 0}>
            <p class="text-11-medium text-red-400 mt-2">
              {props.job.state.consecutiveErrors} consecutive error(s)
              {props.job.state.lastError ? `: ${props.job.state.lastError}` : ""}
            </p>
          </Show>
        </div>
      </div>

      {/* Run history — always visible, session-like conversation log */}
      <div class="border-t border-border-weak-base">
        <RunHistoryPanel jobId={props.job.id} api={props.api} />
      </div>
    </div>
  )
}
