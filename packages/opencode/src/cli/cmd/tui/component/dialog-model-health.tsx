/**
 * Model Health Dashboard
 *
 * Displays real-time status of all tracked models:
 * - Available models (healthy)
 * - Rate-limited models (with cooldown time remaining)
 */

import { createMemo, createSignal, onCleanup } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { getModelHealthRegistry } from "@/account/rotation"
import { Keybind } from "@/util/keybind"
import { debugCheckpoint } from "@/util/debug"

export function DialogModelHealth() {
  const dialog = useDialog()

  // Auto-refresh every second to update countdown timers
  const [tick, setTick] = createSignal(0)
  const interval = setInterval(() => setTick((t) => t + 1), 1000)
  onCleanup(() => clearInterval(interval))

  const options = createMemo(() => {
    // Force re-computation on tick
    tick()

    debugCheckpoint("health", "dashboard.getSnapshot", { tick: tick() })
    const registry = getModelHealthRegistry()
    const snapshot = registry.getSnapshot()
    debugCheckpoint("health", "dashboard.snapshot", { size: snapshot.size, keys: Array.from(snapshot.keys()) })

    const items: Array<{
      value: string
      title: string
      description: string
      category: string
      footer: string
    }> = []

    // Convert snapshot to sorted array
    const entries = Array.from(snapshot.entries()).sort((a, b) => {
      // Sort by category (rate-limited first), then by name
      const aLimited = a[1].waitMs > 0
      const bLimited = b[1].waitMs > 0
      if (aLimited !== bLimited) return aLimited ? -1 : 1
      return a[0].localeCompare(b[0])
    })

    // Table format: Provider | Account | Model | Status
    for (const [key, state] of entries) {
      const [provider, model] = key.split(":")
      const isLimited = state.waitMs > 0

      // Status column
      let status: string
      if (isLimited) {
        const waitSec = Math.ceil(state.waitMs / 1000)
        const waitMin = Math.floor(waitSec / 60)
        const waitSecRemainder = waitSec % 60
        status = waitMin > 0 ? `⏳ ${waitMin}m ${waitSecRemainder}s` : `⏳ ${waitSec}s`
      } else {
        status = "✓ Ready"
      }

      // Format as table row: Provider | Account | Model
      const providerCol = (provider || "-").padEnd(12).slice(0, 12)
      const accountCol = "default".padEnd(10).slice(0, 10)  // Account not tracked yet
      const modelCol = (model || key).padEnd(28).slice(0, 28)

      items.push({
        value: key,
        title: `${providerCol} ${accountCol} ${modelCol}`,
        description: isLimited ? formatReason(state.reason) : "",
        category: "",
        footer: status,
      })
    }

    // If no models tracked yet, show a simple message
    if (items.length === 0) {
      items.push({
        value: "empty",
        title: "No models tracked yet",
        description: "Models will appear here after being used",
        category: "",
        footer: "",
      })
    } else {
      // Add header row at the beginning
      items.unshift({
        value: "_header",
        title: "Provider     Account    Model                       ",
        description: "",
        category: "",
        footer: "Status",
      })
    }

    return items
  })

  // Summary stats
  const stats = createMemo(() => {
    tick()
    const registry = getModelHealthRegistry()
    const snapshot = registry.getSnapshot()

    let available = 0
    let limited = 0

    for (const [, state] of snapshot) {
      if (state.waitMs > 0) {
        limited++
      } else {
        available++
      }
    }

    return { available, limited, total: available + limited }
  })

  const title = createMemo(() => {
    const s = stats()
    if (s.total === 0) return "Model Health"
    return `Model Health (${s.available}✓ ${s.limited}⏳)`
  })

  return (
    <DialogSelect
      title={title()}
      options={options()}
      skipFilter={true}
      hideInput={true}
      hoverSelect={false}
      onSelect={() => {
        // No action on select, this is a read-only dashboard
      }}
      keybind={[
        {
          keybind: Keybind.parse("tab")[0],
          title: "(Tab)Close",
          label: "",
          onTrigger: () => {
            dialog.pop()
          },
        },
        {
          keybind: Keybind.parse("left")[0],
          title: "(←)Back",
          label: "",
          hidden: true,
          onTrigger: () => {
            dialog.pop()
          },
        },
        {
          keybind: Keybind.parse("r")[0],
          title: "(R)efresh",
          label: "",
          onTrigger: () => {
            setTick((t) => t + 1)
          },
        },
        {
          keybind: Keybind.parse("c")[0],
          title: "(C)lear",
          label: "",
          onTrigger: () => {
            const registry = getModelHealthRegistry()
            registry.clearAll()
            setTick((t) => t + 1)
          },
        },
      ]}
      keybindLayout="inline"
    />
  )
}

function formatReason(reason: string): string {
  switch (reason) {
    case "QUOTA_EXHAUSTED":
      return "Quota exhausted"
    case "RATE_LIMIT_EXCEEDED":
      return "Rate limit (RPM)"
    case "MODEL_CAPACITY_EXHAUSTED":
      return "Model capacity"
    case "SERVER_ERROR":
      return "Server error"
    default:
      return reason || "Unknown"
  }
}
