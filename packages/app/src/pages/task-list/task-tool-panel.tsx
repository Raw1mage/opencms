import { createSignal, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import type { CronJob } from "./api"

export function TaskToolPanel(props: {
  job: CronJob
  onTest: () => void
  onEdit: () => void
  onRefresh: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const [testing, setTesting] = createSignal(false)

  async function handleTest() {
    setTesting(true)
    try {
      props.onTest()
    } finally {
      setTimeout(() => setTesting(false), 2000)
    }
  }

  return (
    <div class="w-48 shrink-0 border-l border-border-base bg-background-base flex flex-col">
      <div class="px-3 py-2.5 border-b border-border-weak-base">
        <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Tools</span>
      </div>

      <div class="flex-1 px-2 py-2 space-y-1">
        <ToolButton
          icon="play"
          label={testing() ? "Running..." : "Test"}
          disabled={testing()}
          onClick={handleTest}
        />
        <ToolButton icon="edit" label="Edit" onClick={props.onEdit} />
        <ToolButton icon="refresh" label="Refresh Log" onClick={props.onRefresh} />

        <div class="border-t border-border-weak-base my-2" />

        <ToolButton
          icon={props.job.enabled ? "pause" : "play"}
          label={props.job.enabled ? "Stop" : "Start"}
          onClick={props.onToggle}
          variant={props.job.enabled ? "default" : "accent"}
        />

        <div class="border-t border-border-weak-base my-2" />

        <ToolButton icon="trash" label="Delete" onClick={props.onDelete} variant="danger" />
      </div>

      {/* Job metadata footer */}
      <div class="shrink-0 px-3 py-2 border-t border-border-weak-base space-y-1">
        <Show when={props.job.payload.kind === "agentTurn" && (props.job.payload as { model?: string }).model}>
          <div class="text-11-medium text-color-dimmed">
            Model: {(props.job.payload as { model?: string }).model}
          </div>
        </Show>
        <div class="text-11-medium text-color-dimmed">
          Target: {props.job.sessionTarget}
        </div>
        <Show when={props.job.state.consecutiveErrors && props.job.state.consecutiveErrors > 0}>
          <div class="text-11-medium text-red-400">
            {props.job.state.consecutiveErrors} error(s)
          </div>
        </Show>
      </div>
    </div>
  )
}

function ToolButton(props: {
  icon: string
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: "default" | "accent" | "danger"
}) {
  const variant = () => props.variant ?? "default"

  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      classList={{
        "w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-13-medium transition-colors cursor-pointer": true,
        "opacity-50 cursor-not-allowed": !!props.disabled,
        "text-color-secondary hover:text-color-primary hover:bg-background-hover": variant() === "default",
        "text-accent-base hover:bg-accent-base/10": variant() === "accent",
        "text-red-400 hover:bg-red-500/10": variant() === "danger",
      }}
    >
      <Icon name={props.icon} size="small" />
      <span>{props.label}</span>
    </button>
  )
}
