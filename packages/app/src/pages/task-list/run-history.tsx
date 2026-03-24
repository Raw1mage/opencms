import { createEffect, createSignal, For, Show } from "solid-js"
import type { CronRunLogEntry } from "./api"
import { formatRelativeTime } from "./cron-utils"

type CronApi = {
  getRuns(id: string, limit?: number): Promise<CronRunLogEntry[]>
}

export function RunHistoryPanel(props: { jobId: string; api: CronApi }) {
  const [runs, setRuns] = createSignal<CronRunLogEntry[]>([])
  const [loading, setLoading] = createSignal(true)

  createEffect(() => {
    void (async () => {
      try {
        const data = await props.api.getRuns(props.jobId, 10)
        setRuns(data)
      } catch {
        // Silently ignore — non-critical
      } finally {
        setLoading(false)
      }
    })()
  })

  return (
    <div class="p-3">
      <Show when={loading()}>
        <p class="text-12-medium text-color-dimmed">Loading history...</p>
      </Show>
      <Show when={!loading() && runs().length === 0}>
        <p class="text-12-medium text-color-dimmed">No runs recorded yet</p>
      </Show>
      <Show when={!loading() && runs().length > 0}>
        <div class="space-y-1.5">
          <For each={runs()}>
            {(run) => (
              <div class="flex items-start gap-2 text-12-medium">
                <span
                  classList={{
                    "shrink-0 w-1.5 h-1.5 rounded-full mt-1.5": true,
                    "bg-green-400": run.status === "ok",
                    "bg-red-400": run.status === "error",
                    "bg-neutral-400": run.status === "skipped" || !run.status,
                  }}
                />
                <div class="min-w-0 flex-1">
                  <span class="text-color-dimmed">{formatRelativeTime(run.startedAtMs)}</span>
                  {run.durationMs != null && (
                    <span class="text-color-dimmed ml-1">({(run.durationMs / 1000).toFixed(1)}s)</span>
                  )}
                  <Show when={run.summary}>
                    <p class="text-color-secondary truncate">{run.summary}</p>
                  </Show>
                  <Show when={run.error}>
                    <p class="text-red-400 truncate">{run.error}</p>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
