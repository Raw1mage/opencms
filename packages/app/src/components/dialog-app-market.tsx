import { Component, createMemo, createSignal, For, Show, createResource } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import "./dialog-app-market.css"

const CARD_MIN_W = 260

/** Unified MCP app entry — covers both standard servers and managed apps */
interface MarketApp {
  id: string
  name: string
  description: string
  icon: string
  kind: "mcp-server" | "managed-app"
  type?: "local" | "remote"
  status: string
  error?: string
  tools: Array<{ id: string; name: string; description: string }>
  enabled: boolean
}

type StatusDisplay = { labelKey: string; color: string }

function statusDisplay(app: MarketApp): StatusDisplay {
  if (app.kind === "mcp-server") {
    switch (app.status) {
      case "connected":
        return { labelKey: "app_market.status.ready", color: "text-success-base" }
      case "disabled":
        return { labelKey: "app_market.status.disabled", color: "text-danger-base" }
      case "failed":
        return { labelKey: "app_market.status.error", color: "text-danger-base" }
      case "needs_auth":
        return { labelKey: "app_market.status.pending_auth", color: "text-warning-base" }
      default:
        return { labelKey: "app_market.status.disabled", color: "text-danger-base" }
    }
  }
  // managed-app
  switch (app.status) {
    case "ready":
      return { labelKey: "app_market.status.ready", color: "text-success-base" }
    case "disabled":
      return { labelKey: "app_market.status.disabled", color: "text-danger-base" }
    case "pending_auth":
    case "pending_config":
      return { labelKey: "app_market.status.pending_auth", color: "text-warning-base" }
    case "pending_install":
      return { labelKey: "app_market.status.available", color: "text-text-weaker" }
    case "error":
      return { labelKey: "app_market.status.error", color: "text-danger-base" }
    default:
      return { labelKey: "app_market.status.available", color: "text-text-weaker" }
  }
}

export const DialogAppMarket: Component = () => {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const [filter, setFilter] = createSignal("")
  const [actionLoading, setActionLoading] = createSignal<string | null>(null)
  const [appMap, setAppMap] = createSignal<Map<string, MarketApp>>(new Map())
  const [expandedTools, setExpandedTools] = createSignal<Set<string>>(new Set())

  function toggleToolsExpand(id: string) {
    setExpandedTools((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const [initialLoaded, setInitialLoaded] = createSignal(false)
  const isMobileViewport = createMediaQuery("(max-width: 767px)")

  async function fetchMarket(): Promise<MarketApp[]> {
    const res = await globalSDK.fetch(`${globalSDK.url}/api/v2/mcp/market`)
    if (!res.ok) return []
    const list: MarketApp[] = await res.json()
    const next = new Map<string, MarketApp>()
    for (const app of list) next.set(app.id, app)
    setAppMap(next)
    if (!initialLoaded()) setInitialLoaded(true)
    return list
  }

  const [, { refetch }] = createResource(fetchMarket)

  const appList = createMemo(() => Array.from(appMap().values()))

  const filtered = createMemo(() => {
    const q = filter().toLowerCase()
    const list = appList()
    if (!q) return list
    return list.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
  })

  const enabledCount = createMemo(() => appList().filter((a) => a.enabled).length)
  const totalCount = createMemo(() => appList().length)

  function getApp(id: string) {
    return appMap().get(id)
  }

  // --- Actions for standard MCP servers ---
  async function toggleMcpServer(app: MarketApp) {
    if (actionLoading()) return
    setActionLoading(app.id)
    try {
      if (app.status === "connected") {
        await globalSDK.fetch(`${globalSDK.url}/api/v2/mcp/${app.id}/disconnect`, { method: "POST" })
      } else {
        await globalSDK.fetch(`${globalSDK.url}/api/v2/mcp/${app.id}/connect`, { method: "POST" })
      }
      await refetch()
    } finally {
      setActionLoading(null)
    }
  }

  // --- Actions for managed apps ---
  function openOAuthConnect(appId: string) {
    window.open(`${globalSDK.url}/api/v2/mcp/apps/${appId}/oauth/connect`, "_blank", "width=600,height=700")
    const poll = setInterval(async () => {
      await refetch()
      const updated = getApp(appId)
      if (updated && updated.status !== "pending_auth" && updated.status !== "pending_config") {
        clearInterval(poll)
      }
    }, 3000)
    setTimeout(() => clearInterval(poll), 120_000)
  }

  async function performManagedAction(app: MarketApp) {
    if (actionLoading()) return
    setActionLoading(app.id)
    try {
      const base = `${globalSDK.url}/api/v2/mcp/apps/${app.id}`
      if (app.status === "pending_install" || app.status === "available") {
        await globalSDK.fetch(`${base}/install`, { method: "POST" })
        await refetch()
        await globalSDK.fetch(`${base}/enable`, { method: "POST" })
      } else if (app.status === "ready") {
        await globalSDK.fetch(`${base}/disable`, { method: "POST" })
      } else if (app.status === "pending_auth" || app.status === "pending_config") {
        openOAuthConnect(app.id)
      } else if (app.status === "disabled") {
        await globalSDK.fetch(`${base}/enable`, { method: "POST" })
      } else if (app.status === "error") {
        const res = await globalSDK.fetch(`${base}/uninstall`, { method: "POST" })
        if (res.ok) await globalSDK.fetch(`${base}/install`, { method: "POST" })
      }
      await refetch()
    } finally {
      setActionLoading(null)
    }
  }

  async function uninstallManaged(app: MarketApp) {
    if (actionLoading()) return
    setActionLoading(app.id)
    try {
      await globalSDK.fetch(`${globalSDK.url}/api/v2/mcp/apps/${app.id}/uninstall`, { method: "POST" })
      await refetch()
    } finally {
      setActionLoading(null)
    }
  }

  // Dispatch action based on kind
  function handleAction(app: MarketApp) {
    if (app.kind === "mcp-server") return toggleMcpServer(app)
    return performManagedAction(app)
  }

  function actionLabel(app: MarketApp): string {
    if (actionLoading() === app.id) return language.t("app_market.action.loading")
    if (app.kind === "mcp-server") {
      return app.status === "connected"
        ? language.t("app_market.action.disable")
        : language.t("app_market.action.enable")
    }
    // managed-app
    if (app.status === "ready") return language.t("app_market.action.disable")
    if (app.status === "pending_auth" || app.status === "pending_config") return language.t("app_market.action.connect")
    if (app.status === "disabled") return language.t("app_market.action.enable")
    if (app.status === "error") return language.t("app_market.action.repair")
    return language.t("app_market.action.install")
  }

  /** Per-app custom action buttons — extensible per app.id */
  function renderAppActions(app: MarketApp, isLoading: boolean) {
    switch (app.id) {
      case "google-calendar":
        return (
          <Show when={app.status === "ready" || app.status === "pending_auth" || app.status === "pending_config"}>
            <button
              onClick={() => openOAuthConnect(app.id)}
              disabled={isLoading}
              class="p-1 rounded text-text-weak hover:text-text-base hover:bg-white/5 transition-colors disabled:opacity-50"
              title="Google OAuth"
            >
              <Icon name="settings-gear" size="small" />
            </button>
          </Show>
        )
      default:
        return null
    }
  }

  /** Icon name for the toggle action button */
  function actionIcon(app: MarketApp): string {
    if (app.kind === "mcp-server") {
      return app.status === "connected" ? "circle-ban-sign" : "circle-check"
    }
    if (app.status === "ready") return "circle-ban-sign"
    if (app.status === "pending_auth" || app.status === "pending_config") return "eye"
    if (app.status === "disabled") return "circle-check"
    if (app.status === "error") return "pencil-line"
    return "plus-small"
  }

  return (
    <Dialog
      title={
        <div class="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            <span>{language.t("app_market.title")}</span>
            <span class="text-13-regular text-text-weak min-w-0">
              {language.t("app_market.description", { installed: String(enabledCount()), total: String(totalCount()) })}
            </span>
          </div>
          <div class="relative w-full md:w-44 md:ml-auto md:mr-8">
            <div class="absolute left-2.5 top-1/2 -translate-y-1/2 text-icon-base">
              <Icon name="magnifying-glass" size="small" />
            </div>
            <input
              type="text"
              placeholder={language.t("app_market.search.placeholder")}
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
              class="w-full pl-8 pr-3 py-1 bg-background-input border border-border-base rounded-sm text-12-regular text-text-base placeholder:text-text-weaker focus:outline-none focus:border-border-focus font-normal"
            />
          </div>
        </div>
      }
      size="x-large"
      class="app-market-resizable"
    >
      {/* Loading / empty / cards */}
      <Show when={!initialLoaded()}>
        <div class="flex items-center justify-center py-12 px-4 text-text-weak text-13-regular">
          {language.t("app_market.loading")}
        </div>
      </Show>

      <Show when={initialLoaded()}>
        <Show
          when={filtered().length > 0}
          fallback={
            <div class="flex items-center justify-center py-12 px-4 text-text-weak text-13-regular">
              {language.t("app_market.empty")}
            </div>
          }
        >
          <div
            class="app-market-grid grid gap-3 px-4 pb-4 overflow-y-auto"
            style={{ "grid-template-columns": `repeat(auto-fill, minmax(${CARD_MIN_W}px, 1fr))` }}
          >
            <For each={filtered()}>
              {(app) => {
                const live = () => getApp(app.id) ?? app
                const sd = () => statusDisplay(live())
                const loading = () => actionLoading() === app.id
                const isActive = () => live().enabled || live().status === "connected"

                return (
                  <div class="app-market-card flex flex-col rounded-lg border border-border-base bg-[#1a1a2e] hover:border-border-hover transition-colors overflow-hidden">
                    <div class="px-2.5 pt-2.5 md:px-2 md:pt-2">
                      <span class="app-market-card-title block min-w-0 whitespace-normal break-words leading-tight text-[15px] font-semibold text-text-strong md:truncate md:text-13-medium md:font-medium md:text-text-base">
                        {live().name}
                      </span>
                    </div>

                    <div class="grid min-w-0 gap-1 px-2.5 pt-1 pb-1.5 md:flex md:items-center md:gap-1.5 md:px-2 md:pt-1 md:pb-1.5">
                      <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1" />
                      <div class="flex flex-wrap items-center justify-end gap-0.5 shrink-0 md:ml-auto">
                        {renderAppActions(live(), loading())}
                        <Show
                          when={
                            live().kind === "managed-app" &&
                            live().status !== "pending_install" &&
                            live().status !== "available"
                          }
                        >
                          <button
                            onClick={() => uninstallManaged(live())}
                            disabled={loading()}
                            class="p-1 rounded text-danger-base hover:bg-white/5 transition-colors disabled:opacity-50"
                            title={language.t("app_market.action.uninstall")}
                          >
                            <Icon name="trash" size="small" />
                          </button>
                        </Show>
                        <button
                          onClick={() => handleAction(live())}
                          disabled={loading()}
                          classList={{
                            "flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors disabled:opacity-50": true,
                            "hover:bg-white/5": true,
                            [sd().color]: true,
                          }}
                          title={actionLabel(live())}
                        >
                          <Icon name={actionIcon(live()) as any} size="small" />
                          <span class="text-11-regular whitespace-nowrap">
                            {language.t(sd().labelKey as any)}
                          </span>
                        </button>
                      </div>
                    </div>

                    <p class="app-market-description min-w-0 px-2.5 text-11-regular text-text-weak leading-snug md:px-2 md:pb-2">
                      {language.t("app_market.card.description", { description: live().description })}
                    </p>

                    {/* Tools list — collapsed by default */}
                    <Show when={live().tools.length > 0}>
                      <div class="app-market-tools mx-3 mb-3 md:mx-2 md:mb-2">
                        <button
                          onClick={() => toggleToolsExpand(live().id)}
                          class="flex items-center gap-1 w-full px-2 py-1 rounded-t bg-background-base/60 border border-border-base/30 text-[11px] text-text-weaker hover:text-text-weak transition-colors"
                        >
                          <Icon
                            name={expandedTools().has(live().id) ? "chevron-down" : "chevron-right"}
                            size="small"
                          />
                          <span>{language.t("app_market.tools_count", { count: String(live().tools.length) })}</span>
                        </button>
                        <Show when={expandedTools().has(live().id)}>
                          <div class="app-market-tools-list flex flex-wrap gap-1 px-2 py-1.5 rounded-b bg-background-base/60 border border-t-0 border-border-base/30 content-start overflow-y-auto">
                            <For each={live().tools}>
                              {(tool) => (
                                <span
                                  class="px-1.5 py-0.5 rounded bg-white/5 text-[11px] text-text-weak h-fit"
                                  title={tool.description || tool.name}
                                >
                                  {tool.name}
                                </span>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </Dialog>
  )
}
