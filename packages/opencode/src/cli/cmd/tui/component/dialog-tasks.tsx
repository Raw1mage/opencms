import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createMemo, onMount, Show } from "solid-js"
import { Locale } from "@/util/locale"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import "opentui-spinner/solid"

export function DialogTasks() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const { theme } = useTheme()
  const kv = useKV()

  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

  // Filter for Sub-agents (sessions with parentID)
  const sessions = createMemo(() => sync.data.session.filter((x) => !!x.parentID))

  const options = createMemo(() => {
    return sessions()
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .map((x) => {
        const status = sync.data.session_status?.[x.id]
        const isWorking = status?.type === "busy"

        return {
          title: x.title || "Untitled Task",
          value: x.id,
          // Group active tasks together
          category: isWorking ? "Active Tasks" : "Task History",
          footer: Locale.time(x.time.updated),
          gutter: isWorking ? (
            <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[Run]</text>}>
              <spinner frames={spinnerFrames} interval={80} color={theme.success} />
            </Show>
          ) : undefined,
          // Show shortened Parent ID reference for context
          description: x.parentID ? `⮑ ${x.parentID.slice(0, 8)}` : undefined,
        }
      })
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Task Dashboard"
      options={options()}
      current={route.data.type === "session" ? route.data.sessionID : undefined}
      onSelect={(option) => {
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
        dialog.clear()
      }}
    />
  )
}
