import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { useGlobalSDK } from "@/context/global-sdk"
import {
  createCronApi,
  type CronJob,
  type CronJobPatchInput,
  type CronJobCreateInput,
} from "./api"
import { CronScheduleDisplay, formatRelativeTime, CRON_PRESETS, describeCronExpr } from "./cron-utils"
import { RunHistoryPanel } from "./run-history"
import { TaskEditDialog } from "./task-create-dialog"
import { TaskToolPanel } from "./task-tool-panel"

export function TaskDetail() {
  const globalSDK = useGlobalSDK()
  const params = useParams<{ jobId?: string }>()
  const api = createMemo(() => createCronApi(globalSDK.url, globalSDK.fetch))

  const [job, setJob] = createSignal<CronJob>()
  const [loading, setLoading] = createSignal(true)
  const [showEdit, setShowEdit] = createSignal(false)
  const [promptDraft, setPromptDraft] = createSignal("")
  const [runHistoryKey, setRunHistoryKey] = createSignal(0)

  async function loadJob() {
    const id = params.jobId
    if (!id) { setLoading(false); return }
    try {
      setLoading(true)
      const data = await api().getJob(id)
      setJob(data)
      const p = data.payload
      setPromptDraft(p.kind === "agentTurn" ? p.message : p.kind === "systemEvent" ? p.text : "")
    } catch {
      setJob(undefined)
    } finally {
      setLoading(false)
    }
  }

  createEffect(on(() => params.jobId, () => { void loadJob() }))

  async function handlePromptSave() {
    const j = job()
    if (!j) return
    const current = j.payload.kind === "agentTurn" ? j.payload.message : ""
    if (promptDraft() === current) return
    await api().updateJob(j.id, {
      payload: { ...j.payload, message: promptDraft() } as CronJobPatchInput["payload"],
    })
    await loadJob()
  }

  async function handleUpdate(id: string, patch: CronJobPatchInput) {
    await api().updateJob(id, patch)
    setShowEdit(false)
    await loadJob()
  }

  async function handleToggle() {
    const j = job()
    if (!j) return
    await api().updateJob(j.id, { enabled: !j.enabled })
    await loadJob()
  }

  async function handleTrigger() {
    const j = job()
    if (!j) return
    await api().triggerJob(j.id)
    setTimeout(() => {
      setRunHistoryKey((k) => k + 1)
      void loadJob()
    }, 2000)
  }

  async function handleDelete() {
    const j = job()
    if (!j) return
    if (!confirm(`Delete task "${j.name}"?`)) return
    await api().deleteJob(j.id)
    // Navigate back to task list
    window.history.back()
  }

  // Empty state when no job selected
  if (!params.jobId) {
    return (
      <div class="flex-1 flex items-center justify-center">
        <div class="text-center">
          <Icon name="checklist" size="large" class="text-color-dimmed mx-auto mb-3" />
          <p class="text-14-medium text-color-dimmed">Select a task to view details</p>
        </div>
      </div>
    )
  }

  return (
    <Show when={!loading()} fallback={
      <div class="flex-1 flex items-center justify-center text-13-medium text-color-dimmed">Loading...</div>
    }>
      <Show when={job()} fallback={
        <div class="flex-1 flex items-center justify-center text-13-medium text-color-dimmed">Task not found</div>
      }>
        {(j) => (
          <div class="flex h-full">
            {/* Main content — three zones */}
            <div class="flex-1 flex flex-col overflow-hidden">
              {/* Header */}
              <div class="shrink-0 flex items-center justify-between px-5 py-3 border-b border-border-base">
                <div class="flex items-center gap-3">
                  <div classList={{
                    "w-2.5 h-2.5 rounded-full": true,
                    "bg-green-400": j().enabled,
                    "bg-neutral-500": !j().enabled,
                  }} />
                  <h2 class="text-16-semibold text-color-primary">{j().name}</h2>
                  <span classList={{
                    "text-11-medium px-1.5 py-0.5 rounded": true,
                    "bg-green-500/15 text-green-400": j().enabled,
                    "bg-neutral-500/15 text-neutral-400": !j().enabled,
                  }}>
                    {j().enabled ? "Active" : "Disabled"}
                  </span>
                </div>
                <CronScheduleDisplay schedule={j().schedule} />
              </div>

              {/* Scrollable body */}
              <div class="flex-1 overflow-y-auto">
                {/* Zone 1: Prompt */}
                <div class="px-5 py-4 border-b border-border-weak-base">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Prompt</span>
                  </div>
                  <textarea
                    class="w-full min-h-[80px] max-h-[200px] resize-y rounded-md border border-border-base bg-background-input px-3 py-2 text-13-medium text-color-primary placeholder:text-color-dimmed focus:outline-none focus:ring-1 focus:ring-accent-base"
                    value={promptDraft()}
                    onInput={(e) => setPromptDraft(e.currentTarget.value)}
                    onBlur={() => void handlePromptSave()}
                    placeholder="Enter prompt for this scheduled task..."
                  />
                </div>

                {/* Zone 2: Cron Config */}
                <div class="px-5 py-4 border-b border-border-weak-base">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Schedule</span>
                  </div>
                  <div class="flex items-center gap-3">
                    <code class="text-13-medium font-mono text-accent-base bg-background-input rounded px-2.5 py-1.5 border border-border-base">
                      {j().schedule.kind === "cron" ? j().schedule.expr : j().schedule.kind === "every" ? `Every ${Math.round(j().schedule.everyMs / 60000)}m` : `At ${(j().schedule as { at: string }).at}`}
                    </code>
                    <Show when={j().schedule.kind === "cron" && j().schedule.tz}>
                      <span class="text-12-medium text-color-dimmed">{(j().schedule as { tz?: string }).tz}</span>
                    </Show>
                  </div>
                  <Show when={j().schedule.kind === "cron"}>
                    <p class="text-12-medium text-color-secondary mt-1.5">
                      {describeCronExpr((j().schedule as { expr: string }).expr)}
                    </p>
                  </Show>
                  <Show when={j().state.nextRunAtMs}>
                    <p class="text-12-medium text-color-dimmed mt-1.5">
                      Next run: {formatRelativeTime(j().state.nextRunAtMs!)}
                    </p>
                  </Show>
                  <div class="flex flex-wrap gap-1.5 mt-3">
                    {CRON_PRESETS.slice(0, 6).map((preset) => (
                      <button
                        class="text-11-medium text-color-dimmed hover:text-color-primary px-2 py-1 rounded bg-background-hover transition-colors"
                        onClick={() => void handleUpdate(j().id, {
                          schedule: { kind: "cron", expr: preset.expr },
                        })}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Zone 3: Execution Log */}
                <div class="px-5 py-4">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Execution Log</span>
                    <Button size="small" variant="ghost" onClick={() => setRunHistoryKey((k) => k + 1)}>
                      Refresh
                    </Button>
                  </div>
                  {/* Key forces re-mount on refresh */}
                  <div data-key={runHistoryKey()}>
                    <RunHistoryPanel jobId={j().id} api={api()} />
                  </div>
                </div>
              </div>
            </div>

            {/* Right side tool panel */}
            <TaskToolPanel
              job={j()}
              onTest={handleTrigger}
              onEdit={() => setShowEdit(true)}
              onRefresh={() => setRunHistoryKey((k) => k + 1)}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />

            {/* Edit dialog */}
            <Show when={showEdit()}>
              <TaskEditDialog
                job={j()}
                onClose={() => setShowEdit(false)}
                onUpdate={handleUpdate}
              />
            </Show>
          </div>
        )}
      </Show>
    </Show>
  )
}
