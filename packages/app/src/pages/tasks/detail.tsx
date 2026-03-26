import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useGlobalSDK } from "@/context/global-sdk"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { createCronApi, type CronJob, type CronJobPatchInput, type CronRunLogEntry } from "@/pages/task-list/api"
import { CronScheduleDisplay, formatRelativeTime } from "@/pages/task-list/cron-utils"
import { TaskEditDialog } from "@/pages/task-list/task-create-dialog"

export default function TasksDetail() {
  const params = useParams()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const api = createMemo(() => createCronApi(globalSDK.url, globalSDK.fetch))

  const [editingJob, setEditingJob] = createSignal<CronJob>()

  // Fetch job details
  const [job, { refetch: refetchJob }] = createResource(
    () => ({ id: params.jobId, url: globalSDK.url }),
    async ({ id }) => {
      if (!id) return undefined
      return api().getJob(id)
    },
  )

  // Fetch run history
  const [runs, { refetch: refetchRuns }] = createResource(
    () => ({ id: params.jobId, url: globalSDK.url }),
    async ({ id }) => {
      if (!id) return []
      return api().getRuns(id, 20)
    },
  )

  // Selected run for viewing session
  const [selectedRunId, setSelectedRunId] = createSignal<string>()
  const selectedRun = createMemo(() => {
    const id = selectedRunId()
    const allRuns = runs() ?? []
    if (id) return allRuns.find((r) => r.runId === id)
    return allRuns[0] // Default to most recent
  })

  async function handleToggle() {
    const j = job()
    if (!j) return
    await api().updateJob(j.id, { enabled: !j.enabled })
    void refetchJob()
  }

  async function handleTrigger() {
    const j = job()
    if (!j) return
    await api().triggerJob(j.id)
    setTimeout(() => {
      void refetchJob()
      void refetchRuns()
    }, 2000)
  }

  async function handleDelete() {
    const j = job()
    if (!j) return
    await api().deleteJob(j.id)
    navigate("/system/tasks")
  }

  async function handleUpdate(id: string, patch: CronJobPatchInput) {
    await api().updateJob(id, patch)
    setEditingJob(undefined)
    void refetchJob()
  }

  return (
    <div class="size-full flex flex-col overflow-hidden">
      {/* Header */}
      <div class="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border-base">
        <div class="flex items-center gap-2">
          <Button size="small" variant="ghost" onClick={() => navigate("/system/tasks")}>
            <Icon name="arrow-left" size="small" />
            Back
          </Button>
          <Show when={job()}>
            {(j) => (
              <>
                <span class="text-16-semibold text-color-primary">{j().name}</span>
                <span
                  class="text-11-medium px-1.5 py-0.5 rounded"
                  classList={{
                    "bg-green-500/15 text-green-400": j().enabled,
                    "bg-zinc-500/15 text-zinc-400": !j().enabled,
                  }}
                >
                  {j().enabled ? "Active" : "Disabled"}
                </span>
              </>
            )}
          </Show>
        </div>
        <Show when={job()}>
          <div class="flex items-center gap-2">
            <Button size="small" variant="ghost" onClick={handleToggle}>
              {job()!.enabled ? "Disable" : "Enable"}
            </Button>
            <Button size="small" variant="ghost" onClick={() => setEditingJob(job()!)}>
              Edit
            </Button>
            <Button size="small" onClick={handleTrigger}>
              Test Run
            </Button>
            <Button size="small" variant="ghost" class="text-red-400" onClick={handleDelete}>
              Delete
            </Button>
          </div>
        </Show>
      </div>

      {/* Split pane */}
      <div class="flex-1 flex overflow-hidden">
        {/* Left: Task config + run history */}
        <div class="w-80 shrink-0 border-r border-border-base overflow-y-auto">
          <Show when={job()}>
            {(j) => (
              <div class="p-4 flex flex-col gap-4">
                {/* Schedule */}
                <div>
                  <h3 class="text-12-semibold text-color-dimmed uppercase tracking-wider mb-2">Schedule</h3>
                  <CronScheduleDisplay schedule={j().schedule} />
                  <Show when={j().state.nextRunAtMs}>
                    {(nextRun) => (
                      <p class="text-12-medium text-color-dimmed mt-1">
                        Next: {formatRelativeTime(nextRun())}
                      </p>
                    )}
                  </Show>
                </div>

                {/* Prompt */}
                <div>
                  <h3 class="text-12-semibold text-color-dimmed uppercase tracking-wider mb-2">Prompt</h3>
                  <div class="text-13-medium text-color-secondary bg-background-subtle rounded p-3 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                    {(() => {
                      const p = j().payload
                      return p.kind === "agentTurn" ? p.message : p.text
                    })()}
                  </div>
                </div>

                {/* Run History */}
                <div>
                  <h3 class="text-12-semibold text-color-dimmed uppercase tracking-wider mb-2">
                    Run History
                    <span class="ml-1 text-color-dimmed">({(runs() ?? []).length})</span>
                  </h3>
                  <Show when={(runs() ?? []).length === 0}>
                    <p class="text-12-medium text-color-dimmed">No runs yet</p>
                  </Show>
                  <div class="flex flex-col gap-1">
                    <For each={runs() ?? []}>
                      {(run) => (
                        <button
                          class="w-full text-left px-3 py-2 rounded text-12-medium transition-colors"
                          classList={{
                            "bg-background-selected": selectedRun()?.runId === run.runId,
                            "hover:bg-background-hover": selectedRun()?.runId !== run.runId,
                          }}
                          onClick={() => setSelectedRunId(run.runId)}
                        >
                          <div class="flex items-center justify-between">
                            <div class="flex items-center gap-1.5">
                              <span
                                class="w-1.5 h-1.5 rounded-full"
                                classList={{
                                  "bg-green-400": run.status === "ok",
                                  "bg-red-400": run.status === "error",
                                  "bg-zinc-400": run.status !== "ok" && run.status !== "error",
                                }}
                              />
                              <span class="text-color-secondary">
                                {new Date(run.startedAtMs).toLocaleString()}
                              </span>
                            </div>
                            <Show when={run.durationMs}>
                              {(ms) => (
                                <span class="text-color-dimmed text-11-medium">
                                  {ms() < 1000 ? `${ms()}ms` : `${(ms() / 1000).toFixed(1)}s`}
                                </span>
                              )}
                            </Show>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </div>

        {/* Right: Session conversation / run summary */}
        <div class="flex-1 overflow-y-auto p-4">
          <Show
            when={selectedRun()}
            fallback={
              <div class="flex flex-col items-center justify-center h-full text-color-dimmed">
                <Icon name="checklist" size="large" />
                <p class="text-13-medium mt-2">Select a run to view details</p>
              </div>
            }
          >
            {(run) => (
              <div class="flex flex-col gap-4">
                {/* Run info */}
                <div class="flex items-center gap-3 text-12-medium text-color-dimmed">
                  <span>Run {run().runId.slice(0, 8)}</span>
                  <span>{new Date(run().startedAtMs).toLocaleString()}</span>
                  <Show when={run().durationMs}>
                    {(ms) => <span>Duration: {ms() < 1000 ? `${ms()}ms` : `${(ms() / 1000).toFixed(1)}s`}</span>}
                  </Show>
                  <span
                    class="px-1.5 py-0.5 rounded text-11-medium"
                    classList={{
                      "bg-green-500/15 text-green-400": run().status === "ok",
                      "bg-red-500/15 text-red-400": run().status === "error",
                      "bg-zinc-500/15 text-zinc-400": run().status !== "ok" && run().status !== "error",
                    }}
                  >
                    {run().status ?? "unknown"}
                  </span>
                </div>

                {/* Session link */}
                <Show when={run().sessionId}>
                  {(sessionId) => (
                    <div class="text-12-medium text-color-dimmed">
                      Session: <span class="font-mono text-color-secondary">{sessionId().slice(0, 16)}...</span>
                    </div>
                  )}
                </Show>

                {/* Summary */}
                <Show when={run().summary}>
                  {(summary) => (
                    <div class="bg-background-subtle rounded-lg p-4">
                      <h4 class="text-12-semibold text-color-dimmed uppercase tracking-wider mb-2">Response</h4>
                      <div class="text-13-medium text-color-primary whitespace-pre-wrap break-words">
                        {summary()}
                      </div>
                    </div>
                  )}
                </Show>

                {/* Error */}
                <Show when={run().error}>
                  {(err) => (
                    <div class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-13-medium text-red-400">
                      {err()}
                    </div>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>

      {/* Edit dialog */}
      <Show when={editingJob()}>
        {(j) => (
          <TaskEditDialog
            job={j()}
            onClose={() => setEditingJob(undefined)}
            onUpdate={handleUpdate}
          />
        )}
      </Show>
    </div>
  )
}
