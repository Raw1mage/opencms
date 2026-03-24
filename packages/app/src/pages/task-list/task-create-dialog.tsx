import { createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import type { CronJobCreateInput } from "./api"
import { CRON_PRESETS, describeCronExpr } from "./cron-utils"

export function TaskCreateDialog(props: {
  onClose: () => void
  onCreate: (input: CronJobCreateInput) => Promise<void>
}) {
  const [name, setName] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [cronExpr, setCronExpr] = createSignal("*/30 * * * *")
  const [timezone, setTimezone] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const cronDescription = () => describeCronExpr(cronExpr())

  async function handleSubmit() {
    const n = name().trim()
    const p = prompt().trim()
    const c = cronExpr().trim()
    if (!n) return setError("Name is required")
    if (!p) return setError("Prompt is required")
    if (!c || c.split(/\s+/).length !== 5) return setError("Cron expression must be 5 fields (min hour dom mon dow)")

    setSubmitting(true)
    setError(undefined)
    try {
      await props.onCreate({
        name: n,
        enabled: true,
        schedule: {
          kind: "cron",
          expr: c,
          tz: timezone().trim() || undefined,
        },
        payload: {
          kind: "agentTurn",
          message: p,
          lightContext: true,
        },
        sessionTarget: "isolated",
        wakeMode: "now",
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={props.onClose}>
      <div
        class="w-full max-w-lg mx-4 rounded-lg border border-border-base bg-background-base shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="flex items-center justify-between px-5 py-3 border-b border-border-weak-base">
          <h2 class="text-15-semibold text-color-primary">New Scheduled Task</h2>
          <button class="text-color-dimmed hover:text-color-secondary text-16-medium" onClick={props.onClose}>
            &times;
          </button>
        </div>

        {/* Body */}
        <div class="px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label class="block text-12-semibold text-color-dimmed uppercase tracking-wider mb-1">Name</label>
            <input
              class="w-full bg-background-input rounded border border-border-base px-3 py-2 text-13-medium text-color-primary focus:outline-none focus:border-accent-base"
              placeholder="e.g. Check stock alerts"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>

          {/* Prompt */}
          <div>
            <label class="block text-12-semibold text-color-dimmed uppercase tracking-wider mb-1">Prompt</label>
            <textarea
              class="w-full h-24 bg-background-input rounded border border-border-base px-3 py-2 text-13-medium text-color-primary resize-none focus:outline-none focus:border-accent-base"
              placeholder="What should the AI do on each run?"
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
            />
          </div>

          {/* Cron expression */}
          <div>
            <label class="block text-12-semibold text-color-dimmed uppercase tracking-wider mb-1">
              Cron Schedule
            </label>
            <div class="flex gap-2">
              <input
                class="flex-1 bg-background-input rounded border border-border-base px-3 py-2 text-13-medium text-color-primary font-mono focus:outline-none focus:border-accent-base"
                placeholder="*/30 * * * *"
                value={cronExpr()}
                onInput={(e) => setCronExpr(e.currentTarget.value)}
              />
              <input
                class="w-28 bg-background-input rounded border border-border-base px-2 py-2 text-12-medium text-color-secondary focus:outline-none focus:border-accent-base"
                placeholder="Timezone"
                value={timezone()}
                onInput={(e) => setTimezone(e.currentTarget.value)}
              />
            </div>
            <p class="text-11-medium text-color-dimmed mt-1">{cronDescription()}</p>
          </div>

          {/* Presets */}
          <div>
            <label class="block text-12-semibold text-color-dimmed uppercase tracking-wider mb-1">Presets</label>
            <div class="flex flex-wrap gap-1.5">
              <For each={CRON_PRESETS}>
                {(preset) => (
                  <button
                    classList={{
                      "text-11-medium rounded px-2 py-1 border transition-colors": true,
                      "border-accent-base text-accent-base bg-accent-base/10": cronExpr() === preset.expr,
                      "border-border-base text-color-dimmed hover:text-color-secondary hover:border-border-base": cronExpr() !== preset.expr,
                    }}
                    onClick={() => setCronExpr(preset.expr)}
                  >
                    {preset.label}
                  </button>
                )}
              </For>
            </div>
          </div>

          <Show when={error()}>
            <div class="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-12-medium text-red-400">
              {error()}
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-weak-base">
          <Button size="small" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="small" onClick={handleSubmit} disabled={submitting()}>
            {submitting() ? "Creating..." : "Create Task"}
          </Button>
        </div>
      </div>
    </div>
  )
}
