import { Component, createMemo, createSignal, For, Show, createResource } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"

interface AppSnapshot {
  id: string
  name: string
  description: string
  version: string
  runtimeStatus: string
  operator: {
    install: string
    auth: string
    config: string
    runtime: string
    error: string
  }
  capabilities: Array<{ id: string; label: string; kind: string }>
  toolContract: { namespace: string; tools: Array<{ id: string; label: string }> }
}

const statusConfig: Record<string, { label: string; color: string; action: string }> = {
  available: { label: "Available", color: "text-text-weaker", action: "Install" },
  pending_install: { label: "Not Installed", color: "text-text-weaker", action: "Install" },
  pending_auth: { label: "Auth Required", color: "text-warning-base", action: "Configure" },
  pending_config: { label: "Config Required", color: "text-warning-base", action: "Configure" },
  disabled: { label: "Disabled", color: "text-text-weak", action: "Enable" },
  ready: { label: "Ready", color: "text-success-base", action: "Open" },
  error: { label: "Error", color: "text-danger-base", action: "Repair" },
}

function appIcon(appId: string) {
  switch (appId) {
    case "google-calendar":
      return "📅"
    default:
      return "📦"
  }
}

export const DialogAppMarket: Component = () => {
  const globalSDK = useGlobalSDK()
  const [filter, setFilter] = createSignal("")
  const [actionLoading, setActionLoading] = createSignal<string | null>(null)

  async function fetchApps(): Promise<AppSnapshot[]> {
    const res = await globalSDK.fetch(`${globalSDK.url}/api/mcp/apps`)
    if (!res.ok) return []
    return res.json()
  }

  const [apps, { refetch }] = createResource(fetchApps)

  const filtered = createMemo(() => {
    const q = filter().toLowerCase()
    const list = apps() ?? []
    if (!q) return list
    return list.filter(
      (a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
    )
  })

  const installedCount = createMemo(() => (apps() ?? []).filter((a) => a.operator.install === "installed").length)
  const totalCount = createMemo(() => (apps() ?? []).length)

  async function performAction(app: AppSnapshot) {
    if (actionLoading()) return
    setActionLoading(app.id)
    try {
      const base = `${globalSDK.url}/api/mcp/apps/${app.id}`
      if (app.operator.install !== "installed") {
        await globalSDK.fetch(`${base}/install`, { method: "POST" })
      } else if (app.operator.runtime === "ready") {
        await globalSDK.fetch(`${base}/disable`, { method: "POST" })
      } else if (app.operator.auth === "required" || app.operator.config === "required") {
        // TODO: open configure flow
      } else if (app.runtimeStatus === "disabled") {
        await globalSDK.fetch(`${base}/enable`, { method: "POST" })
      } else if (app.runtimeStatus === "error") {
        const res = await globalSDK.fetch(`${base}/uninstall`, { method: "POST" })
        if (res.ok) await globalSDK.fetch(`${base}/install`, { method: "POST" })
      }
      await refetch()
    } finally {
      setActionLoading(null)
    }
  }

  async function uninstall(app: AppSnapshot) {
    if (actionLoading()) return
    setActionLoading(app.id)
    try {
      await globalSDK.fetch(`${globalSDK.url}/api/mcp/apps/${app.id}/uninstall`, { method: "POST" })
      await refetch()
    } finally {
      setActionLoading(null)
    }
  }

  function statusOf(app: AppSnapshot) {
    if (app.operator.install !== "installed") return statusConfig["available"]!
    return statusConfig[app.runtimeStatus] ?? statusConfig["available"]!
  }

  return (
    <Dialog
      title="App Market"
      description={`${installedCount()} installed / ${totalCount()} available`}
      size="x-large"
    >
      <div class="flex flex-col gap-4 min-h-[400px]">
        {/* Search */}
        <div class="relative">
          <div class="absolute left-3 top-1/2 -translate-y-1/2 text-icon-base">
            <Icon name="magnifying-glass" size="small" />
          </div>
          <input
            type="text"
            placeholder="Search apps..."
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            class="w-full pl-9 pr-3 py-2 bg-background-input border border-border-base rounded-sm text-13-regular text-text-base placeholder:text-text-weaker focus:outline-none focus:border-border-focus"
            autofocus
          />
        </div>

        {/* Loading */}
        <Show when={apps.loading}>
          <div class="flex items-center justify-center py-12 text-text-weak text-13-regular">Loading...</div>
        </Show>

        {/* Grid */}
        <Show when={!apps.loading}>
          <Show
            when={filtered().length > 0}
            fallback={
              <div class="flex items-center justify-center py-12 text-text-weak text-13-regular">
                No apps found
              </div>
            }
          >
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <For each={filtered()}>
                {(app) => {
                  const status = () => statusOf(app)
                  const isInstalled = () => app.operator.install === "installed"
                  const isReady = () => app.runtimeStatus === "ready"
                  const loading = () => actionLoading() === app.id

                  return (
                    <div class="flex flex-col gap-3 p-4 rounded-md border border-border-base bg-background-surface hover:border-border-hover transition-colors">
                      {/* Header */}
                      <div class="flex items-start gap-3">
                        <div class="shrink-0 w-10 h-10 rounded-md bg-background-input flex items-center justify-center text-xl">
                          {appIcon(app.id)}
                        </div>
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2">
                            <span class="text-13-medium text-text-base truncate">{app.name}</span>
                            <span class="text-11-regular text-text-weaker">v{app.version}</span>
                          </div>
                          <span class={`text-11-regular ${status().color}`}>{status().label}</span>
                        </div>
                      </div>

                      {/* Description */}
                      <p class="text-12-regular text-text-weak line-clamp-2 leading-relaxed">
                        {app.description}
                      </p>

                      {/* Capabilities */}
                      <div class="flex flex-wrap gap-1">
                        <For each={app.capabilities.filter((c) => c.kind === "tool").slice(0, 3)}>
                          {(cap) => (
                            <span class="px-1.5 py-0.5 rounded-xs bg-background-input text-11-regular text-text-weak">
                              {cap.label}
                            </span>
                          )}
                        </For>
                        <Show when={app.toolContract.tools.length > 0}>
                          <span class="px-1.5 py-0.5 rounded-xs bg-background-input text-11-regular text-text-weaker">
                            {app.toolContract.tools.length} tools
                          </span>
                        </Show>
                      </div>

                      {/* Actions */}
                      <div class="flex items-center gap-2 mt-auto pt-1">
                        <button
                          onClick={() => performAction(app)}
                          disabled={loading()}
                          classList={{
                            "flex-1 py-1.5 rounded-sm text-12-medium transition-colors text-center": true,
                            "bg-brand-base text-white hover:bg-brand-hover": !isInstalled() || !isReady(),
                            "bg-background-input text-text-base hover:bg-background-input-hover": isReady(),
                            "opacity-50 cursor-not-allowed": loading(),
                          }}
                        >
                          {loading() ? "..." : isReady() ? "Disable" : status().action}
                        </button>
                        <Show when={isInstalled()}>
                          <button
                            onClick={() => uninstall(app)}
                            disabled={loading()}
                            class="px-2 py-1.5 rounded-sm text-12-medium text-danger-base bg-background-input hover:bg-background-input-hover transition-colors disabled:opacity-50"
                            title="Uninstall"
                          >
                            <Icon name="trash" size="small" />
                          </button>
                        </Show>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
