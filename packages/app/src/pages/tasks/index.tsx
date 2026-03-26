import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useGlobalSDK } from "@/context/global-sdk"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { createCronApi, type CronJob, type CronJobCreateInput, type CronJobPatchInput } from "@/pages/task-list/api"
import { TaskCard } from "@/pages/task-list/task-card"
import { TaskEditDialog } from "@/pages/task-list/task-create-dialog"

export default function TasksIndex() {
  const globalSDK = useGlobalSDK()
  const navigate = useNavigate()
  const api = createMemo(() => createCronApi(globalSDK.url, globalSDK.fetch))

  const [jobs, setJobs] = createSignal<CronJob[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [showCreate, setShowCreate] = createSignal(false)
  const [editingJob, setEditingJob] = createSignal<CronJob>()

  async function refresh() {
    try {
      setError(undefined)
      const data = await api().listJobs()
      setJobs(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  createEffect(on(() => globalSDK.url, () => {
    void refresh()
  }))

  async function handleCreate(input: CronJobCreateInput) {
    await api().createJob(input)
    setShowCreate(false)
    await refresh()
  }

  async function handleDelete(id: string) {
    await api().deleteJob(id)
    await refresh()
  }

  async function handleToggle(job: CronJob) {
    await api().updateJob(job.id, { enabled: !job.enabled })
    await refresh()
  }

  async function handleTrigger(id: string) {
    await api().triggerJob(id)
    setTimeout(() => void refresh(), 1500)
  }

  async function handleUpdate(id: string, patch: CronJobPatchInput) {
    await api().updateJob(id, patch)
    setEditingJob(undefined)
    await refresh()
  }

  return (
    <div class="size-full flex flex-col overflow-hidden">
      {/* Header */}
      <div class="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border-base">
        <div class="flex items-center gap-2">
          <Icon name="checklist" size="medium" />
          <h1 class="text-16-semibold text-color-primary">Scheduled Tasks</h1>
          <span class="text-12-medium text-color-dimmed">{jobs().length}</span>
        </div>
        <div class="flex items-center gap-2">
          <Button size="small" variant="ghost" onClick={() => void refresh()}>
            Refresh
          </Button>
          <Button size="small" onClick={() => setShowCreate(true)}>
            New Task
          </Button>
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto p-4">
        <Show when={error()}>
          <div class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-13-medium text-red-400 mb-4">
            {error()}
          </div>
        </Show>

        <Show when={loading()}>
          <div class="flex items-center justify-center py-12 text-color-dimmed text-13-medium">
            Loading tasks...
          </div>
        </Show>

        <Show when={!loading() && jobs().length === 0 && !error()}>
          <div class="flex flex-col items-center justify-center py-16 gap-4">
            <Icon name="checklist" size="large" class="text-color-dimmed" />
            <p class="text-13-medium text-color-dimmed">No scheduled tasks yet</p>
            <p class="text-12-medium text-color-dimmed max-w-xs text-center">
              Create a task with a prompt and cron schedule to automate AI workflows
            </p>
            <Button size="small" onClick={() => setShowCreate(true)}>
              Create First Task
            </Button>
          </div>
        </Show>

        <Show when={!loading() && jobs().length > 0}>
          <div class="flex flex-col gap-3">
            <For each={jobs()}>
              {(job) => (
                <div onClick={() => navigate(`/system/tasks/${job.id}`)} class="cursor-pointer">
                  <TaskCard
                    job={job}
                    api={api()}
                    onDelete={() => void handleDelete(job.id)}
                    onToggle={() => void handleToggle(job)}
                    onTrigger={() => void handleTrigger(job.id)}
                    onUpdate={(patch) => void handleUpdate(job.id, patch)}
                    onEdit={() => setEditingJob(job)}
                  />
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      {/* Create dialog */}
      <Show when={showCreate()}>
        <TaskEditDialog
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      </Show>

      {/* Edit dialog */}
      <Show when={editingJob()}>
        {(job) => (
          <TaskEditDialog
            job={job()}
            onClose={() => setEditingJob(undefined)}
            onUpdate={handleUpdate}
          />
        )}
      </Show>
    </div>
  )
}
