import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { normalizeServerUrl, useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { DialogSettings } from "@/components/dialog-settings"
import { ServerRow } from "@/components/server/server-row"
import { checkServerHealth, type ServerHealth } from "@/utils/server-health"

const pollMs = 10_000

const pluginEmptyMessage = (value: string, file: string): JSX.Element => {
  const parts = value.split(file)
  if (parts.length === 1) return value
  return (
    <>
      {parts[0]}
      <code class="bg-surface-raised-base px-1.5 py-0.5 rounded-sm text-text-base">{file}</code>
      {parts.slice(1).join(file)}
    </>
  )
}

const listServersByHealth = (
  list: string[],
  active: string | undefined,
  status: Record<string, ServerHealth | undefined>,
) => {
  if (!list.length) return list
  const order = new Map(list.map((url, index) => [url, index] as const))
  const rank = (value?: ServerHealth) => {
    if (value?.healthy === true) return 0
    if (value?.healthy === false) return 2
    return 1
  }

  return list.slice().sort((a, b) => {
    if (a === active) return -1
    if (b === active) return 1
    const diff = rank(status[a]) - rank(status[b])
    if (diff !== 0) return diff
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

const useServerHealth = (servers: Accessor<string[]>, fetcher: typeof fetch) => {
  const [status, setStatus] = createStore({} as Record<string, ServerHealth | undefined>)

  createEffect(() => {
    const list = servers()
    let dead = false

    const refresh = async () => {
      const results: Record<string, ServerHealth> = {}
      await Promise.all(
        list.map(async (url) => {
          results[url] = await checkServerHealth(url, fetcher)
        }),
      )
      if (dead) return
      setStatus(reconcile(results))
    }

    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return status
}

const useDefaultServerUrl = (
  get: (() => string | Promise<string | null | undefined> | null | undefined) | undefined,
) => {
  const [url, setUrl] = createSignal<string | undefined>()
  const [tick, setTick] = createSignal(0)

  createEffect(() => {
    tick()
    let dead = false
    const result = get?.()
    if (!result) {
      setUrl(undefined)
      onCleanup(() => {
        dead = true
      })
      return
    }

    if (result instanceof Promise) {
      void result.then((next) => {
        if (dead) return
        setUrl(next ? normalizeServerUrl(next) : undefined)
      })
      onCleanup(() => {
        dead = true
      })
      return
    }

    setUrl(normalizeServerUrl(result))
    onCleanup(() => {
      dead = true
    })
  })

  return { url, refresh: () => setTick((value) => value + 1) }
}

const useMcpToggle = (input: {
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  language: ReturnType<typeof useLanguage>
}) => {
  const [loading, setLoading] = createSignal<string | null>(null)

  const toggle = async (name: string) => {
    if (loading()) return
    setLoading(name)

    try {
      const status = input.sync.data.mcp[name]
      await (status?.status === "connected"
        ? input.sdk.client.mcp.disconnect({ name })
        : input.sdk.client.mcp.connect({ name }))
      const result = await input.sdk.client.mcp.status()
      if (result.data) input.sync.set("mcp", result.data)
    } catch (err) {
      showToast({
        variant: "error",
        title: input.language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoading(null)
    }
  }

  return { loading, toggle }
}

export function SessionStatusSections(props: {
  summaryContent?: JSX.Element
  todoContent?: JSX.Element
  monitorContent?: JSX.Element
}) {
  const sync = useSync()
  const sdk = useSDK()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()

  const fetcher = platform.fetch ?? globalThis.fetch
  const servers = createMemo(() => {
    const current = server.url
    const list = server.list
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((item) => item !== current)]
  })
  const health = useServerHealth(servers, fetcher)
  const sortedServers = createMemo(() => listServersByHealth(servers(), server.url, health))
  const mcp = useMcpToggle({ sync, sdk, language })
  const defaultServer = useDefaultServerUrl(platform.getDefaultServerUrl)
  const mcpNames = createMemo(() => Object.keys(sync.data.mcp ?? {}).sort((a, b) => a.localeCompare(b)))
  const mcpStatus = (name: string) => sync.data.mcp?.[name]?.status
  const lspItems = createMemo(() => sync.data.lsp ?? [])
  const plugins = createMemo(() => sync.data.config.plugin ?? [])
  const pluginEmpty = createMemo(() => pluginEmptyMessage(language.t("dialog.plugins.empty"), "opencode.json"))
  const [expanded, setExpanded] = createStore({
    servers: true,
    summary: true,
    monitor: true,
    todo: true,
    mcp: true,
    lsp: true,
    plugins: true,
  })

  const renderSection = (
    key: keyof typeof expanded,
    title: string,
    children: JSX.Element,
    options?: { hidden?: boolean },
  ) => {
    if (options?.hidden) return null
    return (
      <section class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-surface-panel px-3 py-3">
        <button
          type="button"
          class="flex items-center gap-2 text-left"
          onClick={() => setExpanded(key, (value) => !value)}
        >
          <span class="text-12-medium text-text-base">{expanded[key] ? "▼" : "▶"}</span>
          <span class="text-12-medium text-text-weak uppercase tracking-wide">{title}</span>
        </button>
        <Show when={expanded[key]}>{children}</Show>
      </section>
    )
  }

  return (
    <div class="bg-background-base px-3 py-3 h-full overflow-auto flex flex-col gap-3">
      {renderSection("summary", "Autonomous", props.summaryContent!, {
        hidden: !props.summaryContent,
      })}

      {renderSection(
        "servers",
        language.t("status.popover.tab.servers"),
        <Show
          when={sortedServers().length > 0}
          fallback={<div class="text-12-regular text-text-weak">{language.t("dialog.server.empty")}</div>}
        >
          <For each={sortedServers()}>
            {(url) => {
              const isBlocked = () => health[url]?.healthy === false
              return (
                <button
                  type="button"
                  class="flex items-center gap-2 w-full min-h-8 pl-2 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                  classList={{
                    "hover:bg-surface-raised-base-hover": !isBlocked(),
                    "cursor-not-allowed": isBlocked(),
                  }}
                  aria-disabled={isBlocked()}
                  onClick={() => {
                    if (isBlocked()) return
                    server.setActive(url)
                    navigate("/")
                  }}
                >
                  <ServerRow
                    url={url}
                    status={health[url]}
                    dimmed={isBlocked()}
                    class="flex items-center gap-2 w-full min-w-0"
                    nameClass="text-14-regular text-text-base truncate"
                    versionClass="text-12-regular text-text-weak truncate"
                    badge={
                      <Show when={url === defaultServer.url()}>
                        <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                          {language.t("common.default")}
                        </span>
                      </Show>
                    }
                  >
                    <div class="flex-1" />
                    <Show when={url === server.url}>
                      <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                    </Show>
                  </ServerRow>
                </button>
              )
            }}
          </For>
          <Button
            type="button"
            variant="secondary"
            class="mt-2 self-start h-8 px-3 py-1.5"
            onClick={() => dialog.show(() => <DialogSelectServer />, defaultServer.refresh)}
          >
            {language.t("status.popover.action.manageServers")}
          </Button>
        </Show>,
      )}

      {renderSection("monitor", language.t("session.tools.monitor"), props.monitorContent!, {
        hidden: !props.monitorContent,
      })}

      {renderSection("todo", language.t("session.tools.todo"), props.todoContent!, {
        hidden: !props.todoContent,
      })}

      {renderSection(
        "mcp",
        language.t("status.popover.tab.mcp"),
        <Show
          when={mcpNames().length > 0}
          fallback={<div class="text-12-regular text-text-weak">{language.t("dialog.mcp.empty")}</div>}
        >
          <For each={mcpNames()}>
            {(name) => {
              const status = () => mcpStatus(name)
              const enabled = () => status() === "connected"
              return (
                <button
                  type="button"
                  class="flex items-center gap-2 w-full min-h-8 pl-2 pr-2 py-1 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                  onClick={() => mcp.toggle(name)}
                  disabled={mcp.loading() === name}
                >
                  <div
                    classList={{
                      "size-1.5 rounded-full shrink-0": true,
                      "bg-icon-success-base": status() === "connected",
                      "bg-icon-critical-base": status() === "failed",
                      "bg-border-weak-base": status() === "disabled",
                      "bg-icon-warning-base": status() === "needs_auth" || status() === "needs_client_registration",
                    }}
                  />
                  <span class="text-14-regular text-text-base truncate flex-1">{name}</span>
                  <div onClick={(event) => event.stopPropagation()}>
                    <Switch checked={enabled()} disabled={mcp.loading() === name} onChange={() => mcp.toggle(name)} />
                  </div>
                </button>
              )
            }}
          </For>
        </Show>,
      )}

      {renderSection(
        "lsp",
        language.t("status.popover.tab.lsp"),
        <Show
          when={lspItems().length > 0}
          fallback={
            <div class="text-12-regular text-text-weak">
              {sync.data.config.lsp === false
                ? "LSPs have been disabled in settings"
                : "LSPs will activate as files are read"}
            </div>
          }
        >
          <For each={lspItems()}>
            {(item) => (
              <div class="flex items-start gap-2 w-full px-2 py-1">
                <div
                  classList={{
                    "size-1.5 rounded-full shrink-0": true,
                    "bg-icon-success-base": item.status === "connected",
                    "bg-icon-critical-base": item.status === "error",
                  }}
                />
                <div class="min-w-0 flex-1">
                  <div class="text-14-regular text-text-base break-all">{item.id}</div>
                  <div class="text-12-regular text-text-weak break-all">{item.root}</div>
                </div>
              </div>
            )}
          </For>
        </Show>,
      )}

      {renderSection(
        "plugins",
        language.t("status.popover.tab.plugins"),
        <Show when={plugins().length > 0} fallback={<div class="text-12-regular text-text-weak">{pluginEmpty()}</div>}>
          <For each={plugins()}>
            {(plugin) => (
              <div class="flex items-center gap-2 w-full px-2 py-1">
                <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                <span class="text-14-regular text-text-base truncate">{plugin}</span>
              </div>
            )}
          </For>
        </Show>,
      )}
    </div>
  )
}
