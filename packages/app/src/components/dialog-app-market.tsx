import { Component, createMemo, createSignal, For, Show, createResource } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"

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

type StatusKey = "available" | "pending_install" | "pending_auth" | "pending_config" | "disabled" | "ready" | "error"

const statusMeta: Record<StatusKey, { labelKey: string; color: string; actionKey: string }> = {
  available: { labelKey: "app_market.status.available", color: "text-text-weaker", actionKey: "app_market.action.install" },
  pending_install: { labelKey: "app_market.status.pending_install", color: "text-text-weaker", actionKey: "app_market.action.install" },
  pending_auth: { labelKey: "app_market.status.pending_auth", color: "text-warning-base", actionKey: "app_market.action.connect" },
  pending_config: { labelKey: "app_market.status.pending_config", color: "text-warning-base", actionKey: "app_market.action.connect" },
  disabled: { labelKey: "app_market.status.disabled", color: "text-text-weak", actionKey: "app_market.action.enable" },
  ready: { labelKey: "app_market.status.ready", color: "text-success-base", actionKey: "app_market.action.open" },
  error: { labelKey: "app_market.status.error", color: "text-danger-base", actionKey: "app_market.action.repair" },
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
  const language = useLanguage()
  const [filter, setFilter] = createSignal("")
  const [actionLoading, setActionLoading] = createSignal<string | null>(null)
  const [appMap, setAppMap] = createSignal<Map<string, AppSnapshot>>(new Map())
  const [initialLoaded, setInitialLoaded] = createSignal(false)

  async function fetchApps(): Promise<AppSnapshot[]> {
    const res = await globalSDK.fetch(`${globalSDK.url}/api/v2/mcp/apps`)
    if (!res.ok) return []
    const list: AppSnapshot[] = await res.json()
    const next = new Map<string, AppSnapshot>()
    for (const app of list) next.set(app.id, app)
    setAppMap(next)
    if (!initialLoaded()) setInitialLoaded(true)
    return list
  }

  const [, { refetch }] = createResource(fetchApps)

  const appList = createMemo(() => Array.from(appMap().values()))

  const filtered = createMemo(() => {
    const q = filter().toLowerCase()
    const list = appList()
    if (!q) return list
    return list.filter(
      (a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
    )
  })

  const installedCount = createMemo(() => appList().filter((a) => a.operator.install === "installed").length)
  const totalCount = createMemo(() => appList().length)

  function getApp(id: string) {
    return appMap().get(id)
  }

  function openOAuthConnect(appId: string) {
    window.open(`${globalSDK.url}/api/v2/mcp/apps/${appId}/oauth/connect`, "_blank", "width=600,height=700")
    const poll = setInterval(async () => {
      await refetch()
      const updated = getApp(appId)
      if (updated && updated.runtimeStatus !== "pending_auth" && updated.runtimeStatus !== "pending_config") {
        clearInterval(poll)
      }
    }, 3000)
    setTimeout(() => clearInterval(poll), 120_000)
  }

  async function performAction(app: AppSnapshot) {
    if (actionLoading()) return
    setActionLoading(app.id)
    try {
      const base = `${globalSDK.url}/api/v2/mcp/apps/${app.id}`
      if (app.operator.install !== "installed") {
        await globalSDK.fetch(`${base}/install`, { method: "POST" })
        await refetch()
        await globalSDK.fetch(`${base}/enable`, { method: "POST" })
      } else if (app.operator.runtime === "ready") {
        await globalSDK.fetch(`${base}/disable`, { method: "POST" })
      } else if (app.runtimeStatus === "pending_auth" || app.runtimeStatus === "pending_config") {
        openOAuthConnect(app.id)
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
      await globalSDK.fetch(`${globalSDK.url}/api/v2/mcp/apps/${app.id}/uninstall`, { method: "POST" })
      await refetch()
    } finally {
      setActionLoading(null)
    }
  }

  function statusOf(app: AppSnapshot) {
    if (app.operator.install !== "installed") return statusMeta["available"]
    return statusMeta[app.runtimeStatus as StatusKey] ?? statusMeta["available"]
  }

  return (
    <Dialog
      title={language.t("app_market.title")}
      description={language.t("app_market.description", { installed: String(installedCount()), total: String(totalCount()) })}
      size="large"
    >
      <div class="flex flex-col gap-4 min-h-[320px] px-2 pt-2 pb-3">
        {/* Search */}
        <div class="relative">
          <div class="absolute left-3 top-1/2 -translate-y-1/2 text-icon-base">
            <Icon name="magnifying-glass" size="small" />
          </div>
          <input
            type="text"
            placeholder={language.t("app_market.search.placeholder")}
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            class="w-full pl-9 pr-3 py-2 bg-background-input border border-border-base rounded-sm text-13-regular text-text-base placeholder:text-text-weaker focus:outline-none focus:border-border-focus"
            autofocus
          />
        </div>

        {/* Initial loading */}
        <Show when={!initialLoaded()}>
          <div class="flex items-center justify-center py-12 text-text-weak text-13-regular">
            {language.t("app_market.loading")}
          </div>
        </Show>

        {/* Grid */}
        <Show when={initialLoaded()}>
          <Show
            when={filtered().length > 0}
            fallback={
              <div class="flex items-center justify-center py-12 text-text-weak text-13-regular">
                {language.t("app_market.empty")}
              </div>
            }
          >
            <div class="flex flex-wrap gap-4">
              <For each={filtered()}>
                {(app) => {
                  const meta = () => statusOf(getApp(app.id) ?? app)
                  const live = () => getApp(app.id) ?? app
                  const isInstalled = () => live().operator.install === "installed"
                  const isReady = () => live().runtimeStatus === "ready"
                  const loading = () => actionLoading() === app.id

                  return (
                    <div class="flex flex-col w-[280px] rounded-lg border border-border-base bg-[#1a1a2e] hover:border-border-hover transition-colors overflow-hidden">
                      {/* Header + description */}
                      <div class="p-4 pb-2">
                        <div class="flex items-center gap-3 mb-2">
                          <div class="shrink-0 w-10 h-10 rounded-lg bg-background-base border border-border-base flex items-center justify-center text-lg">
                            {appIcon(app.id)}
                          </div>
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-1.5">
                              <span class="text-13-medium text-text-base truncate">{live().name}</span>
                              <span class="text-11-regular text-text-weaker">v{live().version}</span>
                            </div>
                            <span class={`text-11-regular ${meta().color}`}>
                              {language.t(meta().labelKey)}
                            </span>
                          </div>
                        </div>
                        <p class="text-12-regular text-text-weak line-clamp-2 leading-snug">
                          {live().description}
                        </p>
                      </div>

                      {/* Capabilities band */}
                      <div class="flex flex-wrap gap-1.5 px-3 py-2 mx-3 mb-3 rounded-md bg-background-base/60 border border-border-base/30">
                        <For each={live().capabilities.filter((c) => c.kind === "tool").slice(0, 3)}>
                          {(cap) => (
                            <span class="px-2 py-0.5 rounded bg-white/5 text-11-regular text-text-weak">
                              {cap.label}
                            </span>
                          )}
                        </For>
                        <Show when={live().toolContract.tools.length > 0}>
                          <span class="px-2 py-0.5 rounded bg-white/5 text-11-regular text-text-weaker">
                            {language.t("app_market.tools_count", { count: String(live().toolContract.tools.length) })}
                          </span>
                        </Show>
                      </div>

                      {/* Actions bar */}
                      <div class="flex items-center gap-2 px-4 py-2.5 mt-auto border-t border-border-base/50 bg-white/[0.03]">
                        <button
                          onClick={() => performAction(live())}
                          disabled={loading()}
                          classList={{
                            "flex-1 py-1.5 rounded-md text-12-medium transition-colors text-center": true,
                            "bg-brand-base text-white hover:bg-brand-hover": !isInstalled() || !isReady(),
                            "bg-background-input text-text-base hover:bg-background-input-hover": isReady(),
                            "opacity-50 cursor-not-allowed": loading(),
                          }}
                        >
                          {loading()
                            ? language.t("app_market.action.loading")
                            : isReady()
                              ? language.t("app_market.action.disable")
                              : language.t(meta().actionKey)}
                        </button>
                        <Show when={isInstalled()}>
                          <button
                            onClick={() => uninstall(live())}
                            disabled={loading()}
                            class="px-2.5 py-1.5 rounded-md text-12-medium text-danger-base bg-background-input hover:bg-background-input-hover transition-colors disabled:opacity-50"
                            title={language.t("app_market.action.uninstall")}
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
