import { createSignal, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import type { CronJob, CronJobPatchInput, CronRunLogEntry } from "./api"
import { CronScheduleDisplay, formatRelativeTime } from "./cron-utils"
import { RunHistoryPanel } from "./run-history"

type CronApi = {
  getRuns(id: string, limit?: number): Promise<CronRunLogEntry[]>
  triggerJob(id: string): Promise<void>
}

export function TaskCard(props: {
  job: CronJob
  api: CronApi
  onDelete: () => void
  onToggle: () => void
  onTrigger: () => void
  onUpdate: (patch: CronJobPatchInput) => void
}) {
  const [editing, setEditing] = createSignal(false)
  const [editPrompt, setEditPrompt] = createSignal("")
  const [showHistory, setShowHistory] = createSignal(false)
  const [testResult, setTestResult] = createSignal<string>()
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

  function startEdit() {
    setEditPrompt(prompt())
    setEditing(true)
  }

  function saveEdit() {
    const text = editPrompt().trim()
    if (!text) return
    const payload = props.job.payload.kind === "agentTurn"
      ? { kind: "agentTurn" as const, message: text }
      : { kind: "systemEvent" as const, text }
    props.onUpdate({ payload })
    setEditing(false)
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(undefined)
    try {
      await props.api.triggerJob(props.job.id)
      // Poll for result
      await new Promise((r) => setTimeout(r, 2000))
      const runs = await props.api.getRuns(props.job.id, 1)
      if (runs.length > 0) {
        const run = runs[0]
        setTestResult(run.summary ?? run.status ?? "Completed")
      } else {
        setTestResult("Triggered — check run history for results")
      }
    } catch (e) {
      setTestResult(`Error: ${e instanceof Error ? e.message : String(e)}`)
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
        <div class="flex items-center gap-1.5 shrink-0">
          <span classList={{ "text-11-medium": true, [statusColor()]: true }}>{statusLabel()}</span>
        </div>
      </div>

      {/* Three-zone body */}
      <div class="grid grid-cols-1 lg:grid-cols-[1fr_1fr_auto] divide-y lg:divide-y-0 lg:divide-x divide-border-weak-base">

        {/* Zone 1: Prompt */}
        <div class="p-3 min-h-[80px]">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Prompt</span>
            <button
              class="text-11-medium text-color-dimmed hover:text-color-secondary"
              onClick={() => editing() ? saveEdit() : startEdit()}
            >
              {editing() ? "Save" : "Edit"}
            </button>
          </div>
          <Show when={editing()} fallback={
            <p class="text-13-medium text-color-secondary whitespace-pre-wrap break-words line-clamp-4">
              {prompt() || <span class="text-color-dimmed italic">No prompt set</span>}
            </p>
          }>
            <textarea
              class="w-full h-20 bg-background-input rounded border border-border-base px-2 py-1.5 text-13-medium text-color-primary resize-none focus:outline-none focus:border-accent-base"
              value={editPrompt()}
              onInput={(e) => setEditPrompt(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit()
                if (e.key === "Escape") setEditing(false)
              }}
            />
          </Show>
        </div>

        {/* Zone 2: AI Execution Viewer */}
        <div class="p-3 min-h-[80px]">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Output</span>
            <button
              class="text-11-medium text-color-dimmed hover:text-color-secondary"
              onClick={() => setShowHistory(!showHistory())}
            >
              {showHistory() ? "Hide History" : "Show History"}
            </button>
          </div>
          <Show when={testing()}>
            <div class="flex items-center gap-2 text-13-medium text-color-dimmed">
              <span class="animate-pulse">Running test...</span>
            </div>
          </Show>
          <Show when={testResult()}>
            <p class="text-13-medium text-color-secondary whitespace-pre-wrap break-words">
              {testResult()}
            </p>
          </Show>
          <Show when={!testing() && !testResult()}>
            <Show when={props.job.state.lastRunAtMs} fallback={
              <p class="text-12-medium text-color-dimmed italic">No runs yet</p>
            }>
              <p class="text-12-medium text-color-dimmed">
                Last run: {formatRelativeTime(props.job.state.lastRunAtMs!)}
                {props.job.state.lastDurationMs ? ` (${(props.job.state.lastDurationMs / 1000).toFixed(1)}s)` : ""}
              </p>
              <Show when={props.job.state.consecutiveErrors && props.job.state.consecutiveErrors > 0}>
                <p class="text-12-medium text-red-400 mt-1">
                  {props.job.state.consecutiveErrors} consecutive error(s)
                  {props.job.state.lastError ? `: ${props.job.state.lastError}` : ""}
                </p>
              </Show>
            </Show>
          </Show>
        </div>

        {/* Zone 3: Cron & Actions */}
        <div class="p-3 min-w-[200px]">
          <div class="mb-2">
            <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Schedule</span>
            <div class="mt-1">
              <CronScheduleDisplay schedule={props.job.schedule} />
            </div>
            <Show when={props.job.state.nextRunAtMs}>
              <p class="text-11-medium text-color-dimmed mt-1">
                Next: {formatRelativeTime(props.job.state.nextRunAtMs!)}
              </p>
            </Show>
          </div>

          {/* Action buttons */}
          <div class="flex flex-wrap gap-1.5 mt-3">
            <Button size="small" variant={props.job.enabled ? "ghost" : "solid"} onClick={props.onToggle}>
              {props.job.enabled ? "Stop" : "Start"}
            </Button>
            <Button size="small" variant="ghost" onClick={handleTest} disabled={testing()}>
              Test
            </Button>
            <Button size="small" variant="ghost" class="text-red-400 hover:text-red-300" onClick={props.onDelete}>
              Delete
            </Button>
          </div>
        </div>
      </div>

      {/* Run history (expandable) */}
      <Show when={showHistory()}>
        <div class="border-t border-border-weak-base">
          <RunHistoryPanel jobId={props.job.id} api={props.api} />
        </div>
      </Show>
    </div>
  )
}
