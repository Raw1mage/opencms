import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLayout } from "@/context/layout"
import { createCronApi, type CronJob } from "./api"
import { formatRelativeTime } from "./cron-utils"

export function TaskSidebar() {
  const globalSDK = useGlobalSDK()
  const layout = useLayout()
  const navigate = useNavigate()
  const params = useParams<{ jobId?: string }>()
  const api = createMemo(() => createCronApi(globalSDK.url, globalSDK.fetch))

  const [jobs, setJobs] = createSignal<CronJob[]>([])
  const [loading, setLoading] = createSignal(true)
  const [editMode, setEditMode] = createSignal(false)

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

  createEffect(on(() => globalSDK.url, () => { void refresh() }))

  async function handleDuplicate(job: CronJob) {
    try {
      const created = await api().createJob({
        name: `${job.name} (copy)`,
        enabled: false,
        schedule: job.schedule,
        payload: job.payload,
        delivery: job.delivery,
        sessionTarget: job.sessionTarget,
        wakeMode: job.wakeMode,
      })
      await refresh()
      navigate(`/system/tasks/${created.id}`)
      layout.sidebar.close()
    } catch {
      // ignore
    }
  }

  async function handleDelete(job: CronJob) {
    if (!confirm(`Delete task "${job.name}"?`)) return
    try {
      await api().deleteJob(job.id)
      await refresh()
      if (params.jobId === job.id) {
        navigate("/system/tasks")
      }
    } catch {
      // ignore
    }
  }

  return (
    <div class="flex flex-col h-full">
      {/* Header */}
      <div class="shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-border-base">
        <span class="text-13-semibold text-color-primary">Scheduled Tasks</span>
        <div class="flex items-center gap-1">
          <Show when={jobs().length > 0}>
            <button
              classList={{
                "text-11-medium px-1.5 py-0.5 rounded transition-colors cursor-pointer": true,
                "bg-accent-base/15 text-accent-base": editMode(),
                "text-color-dimmed hover:text-color-secondary": !editMode(),
              }}
              onClick={() => setEditMode(!editMode())}
            >
              {editMode() ? "Done" : "Edit"}
            </button>
          </Show>
          <Button size="small" onClick={() => { navigate("/system/tasks/new"); layout.sidebar.close() }}>
            <Icon name="plus" size="small" />
          </Button>
        </div>
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
                  editMode={editMode()}
                  onClick={() => { navigate(`/system/tasks/${job.id}`); if (!layout.sidebar.opened()) layout.sidebar.close() }}
                  onDuplicate={() => void handleDuplicate(job)}
                  onDelete={() => void handleDelete(job)}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

function TaskSidebarItem(props: {
  job: CronJob
  active: boolean
  editMode: boolean
  onClick: () => void
  onDuplicate: () => void
  onDelete: () => void
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
    <div
      classList={{
        "w-full flex items-center gap-1 pr-1 transition-colors": true,
        "bg-background-brand-dimmed": props.active,
        "hover:bg-background-hover": !props.active,
      }}
    >
      {/* Main clickable area */}
      <button
        onClick={props.onClick}
        class="flex-1 min-w-0 px-3 py-2 flex items-start gap-2.5 text-left cursor-pointer"
      >
        <div classList={{ "w-2 h-2 rounded-full shrink-0 mt-1.5": true, [statusDot()]: true }} />
        <div class="flex-1 min-w-0">
          <div class="text-13-medium text-color-primary truncate">{props.job.name}</div>
          <div class="text-11-medium text-color-dimmed truncate">{nextRun()}</div>
        </div>
      </button>

      {/* Edit mode actions */}
      <Show when={props.editMode}>
        <DropdownMenu placement="bottom-end">
          <DropdownMenu.Trigger
            class="shrink-0 flex items-center justify-center size-6 rounded-md text-icon-base bg-surface-raised-base hover:bg-surface-raised-base-hover border border-border-weak-base shadow-xs cursor-pointer"
          >
            <Icon name="dot-grid" size="small" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={props.onDuplicate}>
              <DropdownMenu.ItemLabel>Duplicate</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item onSelect={props.onDelete}>
              <DropdownMenu.ItemLabel>Delete</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </Show>
    </div>
  )
}
