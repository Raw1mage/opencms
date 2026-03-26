import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { useGlobalSDK } from "@/context/global-sdk"
import { createCronApi, type CronJob, type CronJobCreateInput } from "./api"
import { formatRelativeTime } from "./cron-utils"
import { TaskEditDialog } from "./task-create-dialog"

export function TaskSidebar() {
  const globalSDK = useGlobalSDK()
  const navigate = useNavigate()
  const params = useParams<{ jobId?: string }>()
  const api = createMemo(() => createCronApi(globalSDK.url, globalSDK.fetch))

  const [jobs, setJobs] = createSignal<CronJob[]>([])
  const [loading, setLoading] = createSignal(true)
  const [showCreate, setShowCreate] = createSignal(false)

  async function refresh() {
    try {
      const data = await api().listJobs()
      setJobs(data)
    } catch {
      // non-critical
    } finally {
      setLoading(false)
    }
  }

  createEffect(on(() => globalSDK.url, () => {
    void refresh()
  }))

  async function handleCreate(input: CronJobCreateInput) {
    const job = await api().createJob(input)
    setShowCreate(false)
    await refresh()
    navigate(`/system/tasks/${job.id}`)
  }

  return (
    <div class="flex flex-col h-full">
      {/* Header */}
      <div class="shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-border-base">
        <span class="text-13-semibold text-color-primary">Scheduled Tasks</span>
        <Button size="small" onClick={() => setShowCreate(true)}>
          <Icon name="plus" size="small" />
        </Button>
      </div>

      {/* Job list */}
      <div class="flex-1 overflow-y-auto">
        <Show when={loading()}>
          <div class="px-3 py-6 text-center text-12-medium text-color-dimmed">Loading...</div>
        </Show>

        <Show when={!loading() && jobs().length === 0}>
          <div class="px-3 py-8 text-center">
            <Icon name="checklist" size="medium" class="text-color-dimmed mx-auto mb-2" />
            <p class="text-12-medium text-color-dimmed">No tasks yet</p>
          </div>
        </Show>

        <Show when={!loading() && jobs().length > 0}>
          <div class="py-1">
            <For each={jobs()}>
              {(job) => (
                <TaskSidebarItem
                  job={job}
                  active={params.jobId === job.id}
                  onClick={() => navigate(`/system/tasks/${job.id}`)}
                />
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
    </div>
  )
}

function TaskSidebarItem(props: {
  job: CronJob
  active: boolean
  onClick: () => void
}) {
  const statusDot = () => {
    if (!props.job.enabled) return "bg-neutral-500"
    if (props.job.state.lastRunStatus === "error") return "bg-red-400"
    if (props.job.state.runningAtMs) return "bg-yellow-400"
    return "bg-green-400"
  }

  const nextRun = () => {
    if (!props.job.enabled) return "Disabled"
    if (props.job.state.nextRunAtMs) return formatRelativeTime(props.job.state.nextRunAtMs)
    return "—"
  }

  return (
    <button
      onClick={props.onClick}
      classList={{
        "w-full px-3 py-2 flex items-start gap-2.5 text-left transition-colors cursor-pointer": true,
        "bg-background-brand-dimmed": props.active,
        "hover:bg-background-hover": !props.active,
      }}
    >
      <div classList={{ "w-2 h-2 rounded-full shrink-0 mt-1.5": true, [statusDot()]: true }} />
      <div class="flex-1 min-w-0">
        <div class="text-13-medium text-color-primary truncate">{props.job.name}</div>
        <div class="text-11-medium text-color-dimmed truncate">{nextRun()}</div>
      </div>
    </button>
  )
}
