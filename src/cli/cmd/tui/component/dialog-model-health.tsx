/**
 * Model Activities Dashboard
 *
 * Displays real-time status of all tracked models:
 * - Available models (healthy)
 * - Rate-limited models (with cooldown time remaining)
 */

import { createMemo, createSignal, onCleanup, createResource } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useLocal } from "@tui/context/local"
import { getModelHealthRegistry, getRateLimitTracker } from "@/account/rotation"
import { Keybind } from "@/util/keybind"
import { debugCheckpoint } from "@/util/debug"
import { Account } from "@/account"
import { Provider } from "@/provider/provider"

export function DialogModelHealth() {
  const dialog = useDialog()
  const local = useLocal()

  // Auto-refresh every second to update countdown timers
  const [tick, setTick] = createSignal(0)
  const interval = setInterval(() => setTick((t) => t + 1), 1000)
  onCleanup(() => clearInterval(interval))

  const [providers] = createResource<Record<string, Provider.Info>>(() => Provider.list().catch(() => ({})))
  const [accounts] = createResource<Record<string, Account.ProviderData>>(() => Account.listAll().catch(() => ({})))

  const data = createMemo(() => {
    // Force re-computation on tick
    tick()

    debugCheckpoint("health", "dashboard.getSnapshot", { tick: tick() })

    // Get 3D rate limit data from RateLimitTracker (used by rotation3d)
    const rateLimitTracker = getRateLimitTracker()
    const rateLimits3D = rateLimitTracker.getSnapshot3D()

    // Also get 2D data from ModelHealthRegistry for "Ready" models
    const registry = getModelHealthRegistry()
    const snapshot2D = registry.getSnapshot()

    const providerMap = providers() ?? {}
    const accountMap = accounts() ?? {}

    debugCheckpoint("health", "dashboard.snapshot", {
      rateLimits3DCount: rateLimits3D.length,
      snapshot2DSize: snapshot2D.size,
    })

    const items: Array<{
      value: string
      title: string
      description: string
      category: string
      footer: string
    }> = []

    const modelLimits = new Map<string, { waitMs: number; reason: string }>()
    const providerLimits = new Map<string, { waitMs: number; reason: string }>()
    for (const entry of rateLimits3D) {
      const hasModel = entry.modelID && entry.modelID.length > 0
      if (hasModel) {
        modelLimits.set(`${entry.accountId}:${entry.providerID}:${entry.modelID}`, {
          waitMs: entry.waitMs,
          reason: entry.reason,
        })
      }
      if (!hasModel) {
        providerLimits.set(`${entry.accountId}:${entry.providerID}`, {
          waitMs: entry.waitMs,
          reason: entry.reason,
        })
      }
    }

    let ready = 0
    let limited = 0

    const providerIds = Object.keys(providerMap).sort((a, b) => a.localeCompare(b))
    for (const providerID of providerIds) {
      const provider = providerMap[providerID]
      if (!provider) continue

      const accountData = accountMap[providerID]
      const accountIds = accountData ? Object.keys(accountData.accounts) : []
      const list = accountIds.length > 0 ? accountIds : ["-"]
      const models = Object.values(provider.models).sort((a, b) => a.id.localeCompare(b.id))

      for (const accountId of list) {
        const info = accountId === "-" ? undefined : accountData?.accounts[accountId]
        const display = info ? Account.getDisplayName(accountId, info, providerID) : accountId
        const accountCol = (display || "-").padEnd(18).slice(0, 18)
        const providerCol = (providerID || "-").padEnd(12).slice(0, 12)

        for (const model of models) {
          const modelCol = (model.id || "-").padEnd(28).slice(0, 28)
          const entry = modelLimits.get(`${accountId}:${providerID}:${model.id}`)
          if (entry && entry.waitMs > 0) {
            limited += 1
            items.push({
              value: `${accountId}:${providerID}:${model.id}`,
              title: `${providerCol} ${accountCol} ${modelCol}`,
              description: formatReason(entry.reason),
              category: "",
              footer: `⏳ ${formatWait(entry.waitMs)}`,
            })
            continue
          }

          const providerLimit = providerLimits.get(`${accountId}:${providerID}`)
          if (providerLimit && providerLimit.waitMs > 0) {
            limited += 1
            items.push({
              value: `${accountId}:${providerID}:${model.id}`,
              title: `${providerCol} ${accountCol} ${modelCol}`,
              description: formatReason(providerLimit.reason),
              category: "",
              footer: `⏳ ${formatWait(providerLimit.waitMs)}`,
            })
            continue
          }

          const state2d = snapshot2D.get(`${providerID}:${model.id}`)
          if (state2d && state2d.waitMs > 0) {
            limited += 1
            items.push({
              value: `${accountId}:${providerID}:${model.id}`,
              title: `${providerCol} ${accountCol} ${modelCol}`,
              description: `${formatReason(state2d.reason)} (model)`,
              category: "",
              footer: `⏳ ${formatWait(state2d.waitMs)}`,
            })
            continue
          }

          if (state2d && state2d.available) {
            ready += 1
            items.push({
              value: `${accountId}:${providerID}:${model.id}`,
              title: `${providerCol} ${accountCol} ${modelCol}`,
              description: "",
              category: "",
              footer: "✓ Ready",
            })
            continue
          }

          continue
        }
      }
    }

    // If no models tracked yet, show a simple message
    if (items.length === 0) {
      items.push({
        value: "empty",
        title: "No models tracked yet",
        description: "Rate limits will appear here when encountered",
        category: "",
        footer: "",
      })
    } else {
      // Add header row at the beginning
      items.unshift({
        value: "_header",
        title: "Provider     Account            Model                       ",
        description: "",
        category: "",
        footer: "Status",
      })
    }

    return { items, stats: { ready, limited, total: ready + limited } }
  })

  // Summary stats
  const stats = createMemo(() => {
    return data().stats
  })

  const title = createMemo(() => {
    const s = stats()
    if (s.total === 0) return "Model Activities"
    return `Model Activities (${s.ready}✓ ${s.limited}⏳)`
  })

  return (
    <DialogSelect
      title={title()}
      options={data().items}
      skipFilter={true}
      hideInput={true}
      hoverSelect={false}
      onSelect={(option: any) => {
        const value = option?.value
        if (!value || value === "_header" || value === "empty") return
        if (typeof value !== "string") return
        const [accountId, providerID, ...rest] = value.split(":")
        const modelID = rest.join(":")
        if (!providerID || !modelID) return
        const resolvedProvider = providerID === "google" ? "google-api" : Account.parseFamily(providerID) || providerID
        debugCheckpoint("health", "select model", { accountId, providerID: resolvedProvider, modelID })
        local.model.set({ providerID: resolvedProvider, modelID }, { recent: true, announce: true })
        dialog.pop()
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
            // Clear both trackers
            const registry = getModelHealthRegistry()
            registry.clearAll()
            const rateLimitTracker = getRateLimitTracker()
            rateLimitTracker.clearAll()
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

function formatWait(waitMs: number): string {
  const waitSec = Math.ceil(waitMs / 1000)
  const waitMin = Math.floor(waitSec / 60)
  const waitSecRemainder = waitSec % 60
  if (waitMin > 0) return `${waitMin}m ${waitSecRemainder}s`
  return `${waitSec}s`
}
