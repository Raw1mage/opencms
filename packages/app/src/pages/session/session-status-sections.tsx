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
import {
  createSortable,
  type DragEvent,
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
} from "@thisbeyond/solid-dnd"
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
import { useLayout } from "@/context/layout"
import { DialogSelectServer } from "@/components/dialog-select-server"
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

export function SessionStatusSections(props: { todoContent?: JSX.Element; monitorContent?: JSX.Element }) {
  const sync = useSync()
  const sdk = useSDK()
  const server = useServer()
  const platform = usePlatform()
  const layout = useLayout()
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
  type StatusCardKey = "monitor" | "todo" | "servers" | "mcp" | "llm"

  const renderSection = (key: StatusCardKey, title: string, children: JSX.Element, options?: { hidden?: boolean }) => {
    if (options?.hidden) return null
    return (
      <section class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-surface-panel px-3 py-3">
        <button
          type="button"
          class="flex items-center gap-2 text-left"
          onClick={() => layout.statusSidebar.toggleExpanded(key)}
        >
          <span class="text-12-medium text-text-base">{layout.statusSidebar.expanded(key)() ? "▼" : "▶"}</span>
          <span class="text-12-medium text-text-weak uppercase tracking-wide">{title}</span>
        </button>
        <Show when={layout.statusSidebar.expanded(key)()}>{children}</Show>
      </section>
    )
  }

  const ERROR_TTL_MS = 5 * 60 * 1000 // show generic errors for 5 minutes

  // Tick signal MUST be declared before any memo that references it (TDZ)
  const [llmTick, setLlmTick] = createSignal(0)
  {
    const id = setInterval(() => setLlmTick((v) => v + 1), 10_000)
    onCleanup(() => clearInterval(id))
  }

  const llmErrors = createMemo(() => sync.data.llm_errors ?? [])
  const activeLlmErrors = createMemo(() => {
    llmTick() // reactive dependency
    const now = Date.now()
    return llmErrors().filter((e) => {
      if (e.backoffMs) return e.timestamp + e.backoffMs > now
      return e.timestamp + ERROR_TTL_MS > now
    })
  })

  const formatAge = (timestamp: number) => {
    llmTick()
    const ago = Date.now() - timestamp
    if (ago < 60_000) return `${Math.floor(ago / 1000)}s ago`
    if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`
    return `${Math.round(ago / 3_600_000 * 10) / 10}h ago`
  }

  const cards = createMemo(() => {
    const result: Array<{ key: StatusCardKey; title: string; content: JSX.Element }> = []

    // LLM status card — always present, shows active errors or "ok" state
    result.push({
      key: "llm",
      title: `LLM 狀態${activeLlmErrors().length > 0 ? ` (${activeLlmErrors().length})` : ""}`,
      content: (
        <Show
          when={activeLlmErrors().length > 0}
          fallback={
            <div class="flex items-center gap-2 py-1">
              <div class="size-1.5 rounded-full bg-icon-success-base shrink-0" />
              <span class="text-12-regular text-text-weak">All models operational</span>
            </div>
          }
        >
          <div class="flex flex-col gap-1">
            <For each={activeLlmErrors()}>
              {(entry) => (
                <div class="flex items-start gap-2 py-1 px-1 rounded-md text-left">
                  <div
                    classList={{
                      "size-1.5 rounded-full shrink-0 mt-1.5": true,
                      "bg-icon-critical-base": entry.type === "auth_failed",
                      "bg-icon-warning-base": entry.type === "ratelimit" || entry.type === "error",
                    }}
                  />
                  <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                    <div class="flex items-center gap-1.5">
                      <span class="text-12-medium text-text-base truncate">{entry.modelId}</span>
                      <span class="text-11-regular text-text-weak shrink-0">{formatAge(entry.timestamp)}</span>
                    </div>
                    <span class="text-11-regular text-text-weak truncate">{entry.providerId}</span>
                    <span class="text-11-regular text-text-critical break-words whitespace-pre-wrap">
                      {entry.message}
                    </span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      ),
    })

    if (props.monitorContent) result.push({ key: "monitor", title: "工作監控", content: props.monitorContent })
    if (props.todoContent)
      result.push({ key: "todo", title: language.t("session.tools.todo"), content: props.todoContent })
    result.push({
      key: "servers",
      title: language.t("status.popover.tab.servers"),
      content: (
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
        </Show>
      ),
    })
    result.push({
      key: "mcp",
      title: language.t("status.popover.tab.mcp"),
      content: (
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
        </Show>
      ),
    })
    const order = layout.statusSidebar.order()
    const orderIndex = new Map(order.map((key, index) => [key, index]))
    return result.sort((a, b) => (orderIndex.get(a.key) ?? 99) - (orderIndex.get(b.key) ?? 99))
  })

  const handleDragEnd = (event: DragEvent) => {
    const from = event.draggable?.id as StatusCardKey | undefined
    const to = event.droppable?.id as StatusCardKey | undefined
    if (!from || !to || from === to) return
    const current = [...layout.statusSidebar.order()]
    const fromIndex = current.indexOf(from)
    const toIndex = current.indexOf(to)
    if (fromIndex === -1 || toIndex === -1) return
    current.splice(toIndex, 0, current.splice(fromIndex, 1)[0]!)
    layout.statusSidebar.setOrder(current)
  }

  return (
    <div class="bg-background-base px-3 py-3 h-full overflow-auto flex flex-col gap-3">
      <DragDropProvider onDragEnd={handleDragEnd} collisionDetector={closestCenter}>
        <DragDropSensors />
        <SortableProvider ids={cards().map((card) => card.key)}>
          <For each={cards()}>
            {(card) => (
              <SortableStatusSection id={card.key}>
                {renderSection(card.key, card.title, card.content)}
              </SortableStatusSection>
            )}
          </For>
        </SortableProvider>
      </DragDropProvider>
    </div>
  )
}

function SortableStatusSection(props: { id: "monitor" | "todo" | "servers" | "mcp" | "llm"; children: JSX.Element }) {
  const sortable = createSortable(props.id)
  return (
    <div use:sortable classList={{ "opacity-40": sortable.isActiveDraggable }}>
      {props.children}
    </div>
  )
}
