import { Component, createMemo, createSignal, For, Show, createResource } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import "./dialog-app-market.css"

const CARD_MIN_W = 260

interface SettingsField {
  key: string
  label: string
  type: "string" | "number" | "boolean" | "select"
  description?: string
  required?: boolean
  secret?: boolean
  default?: string | number | boolean
  options?: Array<{ label: string; value: string }>
}

/** Unified MCP app entry — covers standard servers, managed apps, and store apps */
interface MarketApp {
  id: string
  name: string
  description: string
  icon: string
  kind: "mcp-server" | "managed-app" | "mcp-app"
  type?: "local" | "remote"
  status: string
  error?: string
  tools: Array<{ id: string; name: string; description: string }>
  enabled: boolean
  auth?: { type: string; provider?: string; tokenEnv?: string; scopes?: string[] }
  toolCount?: number
  settingsSchema?: { fields: SettingsField[] }
  config?: Record<string, string | number | boolean>
}

type StatusDisplay = { labelKey: string; color: string }

function statusDisplay(app: MarketApp): StatusDisplay {
  if (app.kind === "mcp-server" || app.kind === "mcp-app") {
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
  const [showAddDialog, setShowAddDialog] = createSignal(false)
  const [addSource, setAddSource] = createSignal("")
  const [addLoading, setAddLoading] = createSignal(false)
  const [addError, setAddError] = createSignal<string | null>(null)
  const [settingsAppId, setSettingsAppId] = createSignal<string | null>(null)
  const [settingsValues, setSettingsValues] = createSignal<Record<string, string | number | boolean>>({})
  const [settingsSaving, setSettingsSaving] = createSignal(false)
  const [settingsError, setSettingsError] = createSignal<string | null>(null)

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

  // --- Actions for store apps (mcp-apps.json) ---
  async function toggleStoreApp(app: MarketApp) {
    if (actionLoading()) return
    setActionLoading(app.id)
    try {
      const storeId = app.id.replace(/^store-/, "")
      await globalSDK.fetch(`${globalSDK.url}/api/v2/mcp/store/apps/${storeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !app.enabled }),
      })
      await refetch()
    } finally {
      setActionLoading(null)
    }
  }

  async function removeStoreApp(app: MarketApp) {
    if (actionLoading()) return
    setActionLoading(app.id)
    try {
      const storeId = app.id.replace(/^store-/, "")
      await globalSDK.fetch(`${globalSDK.url}/api/v2/mcp/store/apps/${storeId}`, {
        method: "DELETE",
      })
      await refetch()
    } finally {
      setActionLoading(null)
    }
  }

  // --- Settings dialog ---
  function openSettings(app: MarketApp) {
    setSettingsAppId(app.id)
    setSettingsValues(app.config ? { ...app.config } : {})
    setSettingsError(null)
  }

  async function saveSettings() {
    const appId = settingsAppId()
    if (!appId) return
    setSettingsSaving(true)
    setSettingsError(null)
    try {
      const storeId = appId.replace(/^store-/, "")
      const res = await globalSDK.fetch(`${globalSDK.url}/api/v2/mcp/store/apps/${storeId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: settingsValues() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" })) as { error?: string }
        setSettingsError(err.error ?? `HTTP ${res.status}`)
        return
      }
      setSettingsAppId(null)
      await refetch()
    } catch (err: any) {
      setSettingsError(err.message ?? "Failed to save config")
    } finally {
      setSettingsSaving(false)
    }
  }

  function updateSettingsValue(key: string, value: string | number | boolean) {
    setSettingsValues((prev) => ({ ...prev, [key]: value }))
  }

  // --- Add new app ---
  async function addNewApp() {
    const source = addSource().trim()
    if (!source) return
    setAddLoading(true)
    setAddError(null)
    try {
      const isGithub = source.startsWith("https://github.com/") || source.startsWith("git@")
      const body = isGithub ? { githubUrl: source } : { path: source }
      const res = await globalSDK.fetch(`${globalSDK.url}/api/v2/mcp/store/apps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" })) as { error?: string }
        setAddError(err.error ?? `HTTP ${res.status}`)
        return
      }
      setShowAddDialog(false)
      setAddSource("")
      await refetch()
    } catch (err: any) {
      setAddError(err.message ?? "Failed to add app")
    } finally {
      setAddLoading(false)
    }
  }

  // Dispatch action based on kind
  function handleAction(app: MarketApp) {
    if (app.kind === "mcp-server") return toggleMcpServer(app)
    if (app.kind === "mcp-app") return toggleStoreApp(app)
    return performManagedAction(app)
  }

  function actionLabel(app: MarketApp): string {
    if (actionLoading() === app.id) return language.t("app_market.action.loading")
    if (app.kind === "mcp-server" || app.kind === "mcp-app") {
      return app.enabled || app.status === "connected"
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

  /** Per-app action buttons: gear icon for apps with auth/settings */
  function renderAppActions(app: MarketApp, isLoading: boolean) {
    const hasAuth = app.auth && app.auth.type !== "none"
    const hasSettings = app.settingsSchema && app.settingsSchema.fields.length > 0

    // Show gear icon for apps with auth or settings schema
    if (hasAuth || hasSettings) {
      if (app.kind === "mcp-app") {
        return (
          <button
            onClick={() => openSettings(app)}
            disabled={isLoading}
            class="p-1 rounded text-text-weak hover:text-text-base hover:bg-white/5 transition-colors disabled:opacity-50"
            title="Settings"
          >
            <Icon name="settings-gear" size="small" />
          </button>
        )
      }
      // Legacy managed apps — use OAuth connect directly
      const storeId = app.id
      return (
        <button
          onClick={() => openOAuthConnect(storeId)}
          disabled={isLoading}
          class="p-1 rounded text-text-weak hover:text-text-base hover:bg-white/5 transition-colors disabled:opacity-50"
          title="Settings"
        >
          <Icon name="settings-gear" size="small" />
        </button>
      )
    }
    return null
  }

  /** Icon name for the toggle action button */
  function actionIcon(app: MarketApp): string {
    if (app.kind === "mcp-server" || app.kind === "mcp-app") {
      return (app.enabled || app.status === "connected") ? "circle-ban-sign" : "circle-check"
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
          <button
            onClick={() => setShowAddDialog(true)}
            class="shrink-0 px-2.5 py-1 rounded-sm border border-border-base bg-background-input text-12-regular text-text-base hover:bg-white/5 transition-colors"
          >
            + Add App
          </button>
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

                    {/* Error banner with retry */}
                    <Show when={live().status === "failed" || live().status === "error"}>
                      <div class="mx-2.5 mb-2 px-2 py-1.5 rounded bg-danger-base/10 border border-danger-base/20 md:mx-2">
                        <p class="text-11-regular text-danger-base truncate" title={live().error}>
                          {live().error || "Connection failed"}
                        </p>
                        <button
                          onClick={() => handleAction(live())}
                          disabled={loading()}
                          class="mt-1 text-11-regular text-danger-base underline hover:no-underline"
                        >
                          Retry
                        </button>
                      </div>
                    </Show>

                    {/* Tools list — collapsed by default */}
                    <Show when={live().tools.length > 0 || (live() as any).toolCount > 0}>
                      <div class="app-market-tools mx-3 mb-3 md:mx-2 md:mb-2">
                        <button
                          onClick={() => toggleToolsExpand(live().id)}
                          class="flex items-center gap-1 w-full px-2 py-1 rounded-t bg-background-base/60 border border-border-base/30 text-[11px] text-text-weaker hover:text-text-weak transition-colors"
                        >
                          <Icon
                            name={expandedTools().has(live().id) ? "chevron-down" : "chevron-right"}
                            size="small"
                          />
                          <span>{language.t("app_market.tools_count", { count: String(live().tools.length || (live() as any).toolCount || 0) })}</span>
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

      {/* Add App Dialog Overlay */}
      <Show when={showAddDialog()}>
        <div class="absolute inset-0 bg-black/60 flex items-center justify-center z-10 rounded-lg">
          <div class="bg-[#1a1a2e] border border-border-base rounded-lg p-6 w-[400px] max-w-[90%]">
            <h3 class="text-14-medium text-text-strong mb-3">Add MCP App</h3>
            <p class="text-12-regular text-text-weak mb-4">
              Enter a local path to an MCP App directory, or a GitHub URL to clone.
            </p>
            <input
              type="text"
              placeholder="/opt/opencode-apps/my-app or https://github.com/owner/repo"
              value={addSource()}
              onInput={(e) => { setAddSource(e.currentTarget.value); setAddError(null) }}
              onKeyDown={(e) => { if (e.key === "Enter") addNewApp() }}
              class="w-full px-3 py-2 bg-background-input border border-border-base rounded-sm text-13-regular text-text-base placeholder:text-text-weaker focus:outline-none focus:border-border-focus mb-3"
            />
            <Show when={addError()}>
              <p class="text-12-regular text-danger-base mb-3">{addError()}</p>
            </Show>
            <div class="flex justify-end gap-2">
              <button
                onClick={() => { setShowAddDialog(false); setAddSource(""); setAddError(null) }}
                class="px-3 py-1.5 rounded-sm text-12-regular text-text-weak hover:text-text-base transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={addNewApp}
                disabled={addLoading() || !addSource().trim()}
                class="px-3 py-1.5 rounded-sm bg-accent-base text-12-regular text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                {addLoading() ? "Adding..." : "Add"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Settings Dialog Overlay */}
      <Show when={settingsAppId()}>
        {(_) => {
          const app = () => getApp(settingsAppId()!)
          const hasAuth = () => app()?.auth && app()!.auth!.type !== "none"
          const hasSettings = () => app()?.settingsSchema && app()!.settingsSchema!.fields.length > 0

          return (
            <div class="absolute inset-0 bg-black/60 flex items-center justify-center z-10 rounded-lg">
              <div class="bg-[#1a1a2e] border border-border-base rounded-lg p-6 w-[480px] max-w-[90%] max-h-[80vh] overflow-y-auto">
                <h3 class="text-14-medium text-text-strong mb-1">{app()?.name ?? "Settings"}</h3>
                <p class="text-11-regular text-text-weaker mb-4">Configure app settings and authentication</p>

                {/* Auth Section */}
                <Show when={hasAuth()}>
                  <div class="mb-4">
                    <h4 class="text-12-medium text-text-base mb-2 flex items-center gap-1.5">
                      <Icon name="eye" size="small" />
                      Authentication
                    </h4>
                    <div class="rounded border border-border-base bg-background-base/40 p-3">
                      <Show when={app()!.auth!.type === "oauth"}>
                        <div class="flex items-center justify-between">
                          <div>
                            <p class="text-12-regular text-text-base">OAuth — {app()!.auth!.provider}</p>
                            <p class="text-11-regular text-text-weaker">
                              {app()!.status === "connected" || app()!.status === "ready"
                                ? "Authenticated"
                                : "Not connected"}
                            </p>
                          </div>
                          <button
                            onClick={() => {
                              const storeId = app()!.id.replace(/^store-/, "")
                              openOAuthConnect(storeId)
                            }}
                            class="px-2.5 py-1 rounded-sm border border-border-base text-12-regular text-text-base hover:bg-white/5 transition-colors"
                          >
                            {app()!.status === "connected" || app()!.status === "ready" ? "Reconnect" : "Connect"}
                          </button>
                        </div>
                      </Show>
                      <Show when={app()!.auth!.type === "api-key"}>
                        <div>
                          <label class="block text-12-regular text-text-base mb-1">
                            API Key ({app()!.auth!.provider})
                          </label>
                          <input
                            type="password"
                            value={String(settingsValues()[app()!.auth!.tokenEnv ?? "API_KEY"] ?? "")}
                            onInput={(e) => updateSettingsValue(app()!.auth!.tokenEnv ?? "API_KEY", e.currentTarget.value)}
                            placeholder="Enter API key"
                            class="w-full px-3 py-1.5 bg-background-input border border-border-base rounded-sm text-12-regular text-text-base placeholder:text-text-weaker focus:outline-none focus:border-border-focus"
                          />
                        </div>
                      </Show>
                    </div>
                  </div>
                </Show>

                {/* Config Section — auto-rendered from settings schema */}
                <Show when={hasSettings()}>
                  <div class="mb-4">
                    <h4 class="text-12-medium text-text-base mb-2 flex items-center gap-1.5">
                      <Icon name="settings-gear" size="small" />
                      Configuration
                    </h4>
                    <div class="rounded border border-border-base bg-background-base/40 p-3 flex flex-col gap-3">
                      <For each={app()!.settingsSchema!.fields}>
                        {(field) => (
                          <div>
                            <label class="block text-12-regular text-text-base mb-1">
                              {field.label}
                              <Show when={field.required}>
                                <span class="text-danger-base ml-0.5">*</span>
                              </Show>
                            </label>
                            <Show when={field.description}>
                              <p class="text-11-regular text-text-weaker mb-1">{field.description}</p>
                            </Show>

                            {/* String / secret input */}
                            <Show when={field.type === "string"}>
                              <input
                                type={field.secret ? "password" : "text"}
                                value={String(settingsValues()[field.key] ?? field.default ?? "")}
                                onInput={(e) => updateSettingsValue(field.key, e.currentTarget.value)}
                                class="w-full px-3 py-1.5 bg-background-input border border-border-base rounded-sm text-12-regular text-text-base placeholder:text-text-weaker focus:outline-none focus:border-border-focus"
                              />
                            </Show>

                            {/* Number input */}
                            <Show when={field.type === "number"}>
                              <input
                                type="number"
                                value={String(settingsValues()[field.key] ?? field.default ?? "")}
                                onInput={(e) => updateSettingsValue(field.key, Number(e.currentTarget.value))}
                                class="w-full px-3 py-1.5 bg-background-input border border-border-base rounded-sm text-12-regular text-text-base placeholder:text-text-weaker focus:outline-none focus:border-border-focus"
                              />
                            </Show>

                            {/* Boolean toggle */}
                            <Show when={field.type === "boolean"}>
                              <button
                                onClick={() => {
                                  const cur = settingsValues()[field.key] ?? field.default ?? false
                                  updateSettingsValue(field.key, !cur)
                                }}
                                class="flex items-center gap-2 text-12-regular text-text-base"
                              >
                                <span classList={{
                                  "inline-block w-8 h-4 rounded-full transition-colors": true,
                                  "bg-accent-base": Boolean(settingsValues()[field.key] ?? field.default),
                                  "bg-border-base": !Boolean(settingsValues()[field.key] ?? field.default),
                                }}>
                                  <span classList={{
                                    "block w-3 h-3 mt-0.5 rounded-full bg-white transition-transform": true,
                                    "translate-x-4": Boolean(settingsValues()[field.key] ?? field.default),
                                    "translate-x-0.5": !Boolean(settingsValues()[field.key] ?? field.default),
                                  }} />
                                </span>
                                {Boolean(settingsValues()[field.key] ?? field.default) ? "Enabled" : "Disabled"}
                              </button>
                            </Show>

                            {/* Select dropdown */}
                            <Show when={field.type === "select" && field.options}>
                              <select
                                value={String(settingsValues()[field.key] ?? field.default ?? "")}
                                onChange={(e) => updateSettingsValue(field.key, e.currentTarget.value)}
                                class="w-full px-3 py-1.5 bg-background-input border border-border-base rounded-sm text-12-regular text-text-base focus:outline-none focus:border-border-focus"
                              >
                                <For each={field.options}>
                                  {(opt) => <option value={opt.value}>{opt.label}</option>}
                                </For>
                              </select>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* Error */}
                <Show when={settingsError()}>
                  <p class="text-12-regular text-danger-base mb-3">{settingsError()}</p>
                </Show>

                {/* Actions */}
                <div class="flex justify-end gap-2">
                  <button
                    onClick={() => { setSettingsAppId(null); setSettingsError(null) }}
                    class="px-3 py-1.5 rounded-sm text-12-regular text-text-weak hover:text-text-base transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveSettings}
                    disabled={settingsSaving()}
                    class="px-3 py-1.5 rounded-sm bg-accent-base text-12-regular text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                  >
                    {settingsSaving() ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            </div>
          )
        }}
      </Show>
    </Dialog>
  )
}
