import { useSync, type LlmHistoryEntry } from "@tui/context/sync"
import { createMemo, createSignal, For, onCleanup, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { Locale } from "@/util/locale"
import path from "path"
import type { AssistantMessage, Part as MessagePart } from "@opencode-ai/sdk/v2"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { useDirectory } from "../../context/directory"
import { useKV } from "../../context/kv"
import { useRoute } from "../../context/route"
import { TodoItem } from "../../component/todo-item"
import { useLocal } from "../../context/local"

const STATUS_LABELS: Record<string, string> = {
  busy: "Running",
  working: "Working",
  idle: "",
  error: "Error",
  retry: "Retrying",
  compacting: "Compacting",
  pending: "Pending",
}
const LEVEL_LABELS: Record<string, string> = {
  session: "S",
  "sub-session": "SS",
  agent: "A",
  "sub-agent": "SA",
  tool: "T",
}

const formatIsoTitle = (title: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(title)) return title
  const date = new Date(title)
  if (Number.isNaN(date.getTime())) return title
  const pad = (value: number) => value.toString().padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.workspace_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const [expanded, setExpanded] = createStore({
    mcp: true,
    diff: false,
    todo: true,
    lsp: true,
    llm: true,
  })

  // Sort MCP servers alphabetically for consistent display order
  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp).sort(([a], [b]) => a.localeCompare(b)))

  // Count connected and error MCP servers for collapsed header display
  const connectedMcpCount = createMemo(() => mcpEntries().filter(([_, item]) => item.status === "connected").length)
  const errorMcpCount = createMemo(
    () =>
      mcpEntries().filter(
        ([_, item]) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerId)?.models[last.modelID]
    return {
      tokens: total.toLocaleString(),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  const monitorFallbackStats = createMemo(() => {
    const persisted = session()?.stats
    if (persisted) {
      return {
        requests: persisted.requestsTotal,
        totalTokens: persisted.totalTokens,
        tokens: persisted.tokens,
        model: undefined as { providerId: string; modelID: string } | undefined,
      }
    }

    const stats = {
      requests: 0,
      totalTokens: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      model: undefined as { providerId: string; modelID: string } | undefined,
    }

    for (const msg of messages()) {
      if (msg.role !== "assistant") continue
      const total =
        msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
      if (total > 0) {
        stats.requests += 1
        if (!stats.model) {
          stats.model = {
            providerId: msg.providerId,
            modelID: msg.modelID,
          }
        }
      }
      stats.tokens.input += msg.tokens.input
      stats.tokens.output += msg.tokens.output
      stats.tokens.reasoning += msg.tokens.reasoning
      stats.tokens.cache.read += msg.tokens.cache.read
      stats.tokens.cache.write += msg.tokens.cache.write
      stats.totalTokens += total
    }

    return stats
  })

  const directory = useDirectory()
  const kv = useKV()
  const route = useRoute()
  const local = useLocal()

  // LLM status card — deduplicated history
  const llmHistory = createMemo(() => {
    const raw = sync.data.llm_history ?? []
    const deduped: LlmHistoryEntry[] = []
    for (const entry of raw) {
      const prev = deduped[deduped.length - 1]
      if (
        prev &&
        prev.providerId === entry.providerId &&
        prev.modelId === entry.modelId &&
        prev.accountId === entry.accountId &&
        prev.state === entry.state
      )
        continue
      deduped.push(entry)
    }
    return deduped.slice(-5)
  })

  const formatTime = (timestamp: number) => {
    const d = new Date(timestamp)
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  }

  const shortModel = (id: string) => {
    const parts = id.split("/")
    return parts[parts.length - 1] ?? id
  }

  const monitorStatusColors = {
    busy: theme.success,
    working: theme.success,
    idle: theme.textMuted,
    error: theme.error,
    retry: theme.warning,
    compacting: theme.textMuted,
    pending: theme.textMuted,
  }

  const activeStatuses = new Set(["busy", "working", "retry", "compacting", "pending"])
  const branchSessionIDs = createMemo(() => {
    const current = session()
    if (!current) return undefined
    const parentMap = new Map<string, string[]>()
    for (const info of sync.data.session) {
      if (!info.parentID) continue
      const children = parentMap.get(info.parentID) ?? []
      children.push(info.id)
      parentMap.set(info.parentID, children)
    }
    const ids = new Set<string>()
    const stack = [current.id]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (ids.has(id)) continue
      ids.add(id)
      const children = parentMap.get(id)
      if (children) stack.push(...children)
    }
    return ids
  })

  const monitorEntries = createMemo(() => {
    const branchSet = branchSessionIDs()
    const raw = (sync.data.monitor ?? [])
      .filter((x) => activeStatuses.has(x.status.type))
      .slice()
      .sort((a, b) => b.updated - a.updated)
    const scoped = branchSet && branchSet.size > 0 ? raw.filter((x) => branchSet.has(x.sessionID)) : raw

    // Deduplicate: If an 'agent' entry and a 'session' entry have the same sessionID and are updated at similar times,
    // prefer the 'agent' entry (or just show one).
    // Actually, usually [A] and [S] are redundant if there is only one active agent.
    // Let's filter out 'session' level entries if there is an 'agent' level entry for the same sessionID.
    const agentSessionIDs = new Set(scoped.filter((x) => x.level === "agent").map((x) => x.sessionID))
    const deduped = scoped.filter((x) => {
      if (x.level === "session" && agentSessionIDs.has(x.sessionID)) return false
      return true
    })

    // @event_2026-02-11_monitor_main_session_fallback:
    // When only the main session exists (or nothing is actively running), keep one
    // monitor row so users can still see main session status.
    if (deduped.length === 0 && session()) {
      const status = sync.data.session_status?.[session()!.id] ?? { type: "idle" as const }
      const fallbackStats = monitorFallbackStats()
      return [
        {
          id: `session:${session()!.id}:fallback`,
          level: session()!.parentID ? "sub-session" : "session",
          sessionID: session()!.id,
          title: formatIsoTitle(session()!.title || "Untitled session"),
          parentID: session()!.parentID,
          agent: undefined,
          status,
          model: fallbackStats.model,
          requests: fallbackStats.requests,
          tokens: fallbackStats.tokens,
          totalTokens: fallbackStats.totalTokens,
          activeTool: undefined,
          activeToolStatus: undefined,
          updated: session()!.time.updated,
        },
      ]
    }

    return deduped
  })
  const activeRouteSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const hasProviders = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const gettingStartedDismissed = createMemo(() => kv.get("dismissed_getting_started", false))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={1} paddingRight={1}>
            <box paddingRight={1}>
              <text fg={theme.text}>
                <b>{session().title}</b>
              </text>
              <Show when={session().share?.url}>
                <text fg={theme.textMuted}>{session().share!.url}</text>
              </Show>
            </box>
            <box>
              <text fg={theme.text}>
                <b>Context</b>
              </text>
              <text fg={theme.textMuted}>{context()?.tokens ?? 0} tokens</text>
              <text fg={theme.textMuted}>{context()?.percentage ?? 0}% used</text>
              <text fg={theme.textMuted}>{cost()} spent</text>
            </box>
            <Show when={monitorEntries().length > 0}>
              <box marginTop={1} gap={1}>
                <text fg={theme.text}>
                  <b>Monitor</b>
                </text>
                <For each={monitorEntries()}>
                  {(info) => {
                    const statusType = info.status.type
                    const dotColor = monitorStatusColors[statusType] ?? theme.textMuted
                    const statusLabel = STATUS_LABELS[statusType]
                    const levelLabel = LEVEL_LABELS[info.level] ?? info.level
                    const currentModel = local.model.current(props.sessionID)
                    const fallbackModel =
                      info.sessionID === props.sessionID && currentModel
                        ? `${currentModel.providerId}/${currentModel.modelID}`
                        : undefined
                    const modelLabel = info.model
                      ? `${info.model.providerId}/${info.model.modelID}`
                      : (fallbackModel ?? "")
                    const title = formatIsoTitle(info.title || "Untitled session")
                    const agentSuffix = info.agent ? ` (${info.agent})` : ""
                    const titleLabel = Locale.truncate(`${title}${agentSuffix}`, 32)
                    const isActiveSession = activeRouteSessionID() === info.sessionID
                    const metaLabel =
                      info.level === "tool"
                        ? modelLabel
                        : `${modelLabel ? `${modelLabel} ` : ""}${info.requests} reqs ${info.totalTokens.toLocaleString()} tok`
                    const toolStatusRedundant =
                      (info.activeToolStatus === "running" && (statusType === "working" || statusType === "busy")) ||
                      (info.activeToolStatus === "pending" && statusType === "pending")
                    const toolStatusLabel =
                      info.activeToolStatus && !toolStatusRedundant ? ` ${Locale.titlecase(info.activeToolStatus)}` : ""
                    const toolLabel = info.activeTool ? `Tool: ${info.activeTool}${toolStatusLabel}` : null
                    return (
                      <box
                        flexDirection="column"
                        paddingLeft={1}
                        paddingRight={1}
                        gap={0}
                        backgroundColor={isActiveSession ? theme.backgroundElement : undefined}
                        onMouseDown={() => route.navigate({ type: "session", sessionID: info.sessionID })}
                      >
                        <box flexDirection="row" gap={1} alignItems="center">
                          <text fg={theme.text} wrapMode="none">
                            <span style={{ fg: theme.textMuted }}>[{levelLabel}]</span> {titleLabel}
                          </text>
                        </box>
                        <box flexDirection="row" gap={1} alignItems="center">
                          <text fg={theme.textMuted} wrapMode="word">
                            <Show when={statusLabel}>
                              <span style={{ fg: dotColor }}>{statusLabel}</span>
                              <span> </span>
                            </Show>
                            <span>{metaLabel}</span>
                            <Show when={toolLabel}>
                              <span> · {toolLabel}</span>
                            </Show>
                          </text>
                        </box>
                      </box>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show when={mcpEntries().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => mcpEntries().length > 2 && setExpanded("mcp", !expanded.mcp)}
                >
                  <Show when={mcpEntries().length > 2}>
                    <text fg={theme.text}>{expanded.mcp ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>MCP</b>
                    <Show when={!expanded.mcp}>
                      <span style={{ fg: theme.textMuted }}>
                        {" "}
                        ({connectedMcpCount()} active
                        {errorMcpCount() > 0 ? `, ${errorMcpCount()} error${errorMcpCount() > 1 ? "s" : ""}` : ""})
                      </span>
                    </Show>
                  </text>
                </box>
                <Show when={mcpEntries().length <= 2 || expanded.mcp}>
                  <For each={mcpEntries()}>
                    {([key, item]) => (
                      <box flexDirection="row" gap={1}>
                        <text
                          flexShrink={0}
                          style={{
                            fg: (
                              {
                                connected: theme.success,
                                failed: theme.error,
                                disabled: theme.textMuted,
                                needs_auth: theme.warning,
                                needs_client_registration: theme.error,
                              } as Record<string, typeof theme.success>
                            )[item.status],
                          }}
                        >
                          •
                        </text>
                        <text fg={theme.text} wrapMode="word">
                          {key}
                          <Show when={item.status !== "connected" && item.status !== "disabled"}>
                            {" "}
                            <span style={{ fg: theme.textMuted }}>
                              <Switch fallback={item.status}>
                                <Match when={item.status === "failed" && item}>{(val) => <i>{val().error}</i>}</Match>
                                <Match when={(item.status as string) === "needs_auth"}>Needs auth</Match>
                                <Match when={(item.status as string) === "needs_client_registration"}>
                                  Needs client ID
                                </Match>
                              </Switch>
                            </span>
                          </Show>
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => sync.data.lsp.length > 2 && setExpanded("lsp", !expanded.lsp)}
              >
                <Show when={sync.data.lsp.length > 2}>
                  <text fg={theme.text}>{expanded.lsp ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>LSP</b>
                </text>
              </box>
              <Show when={sync.data.lsp.length <= 2 || expanded.lsp}>
                <Show when={sync.data.lsp.length === 0}>
                  <text fg={theme.textMuted}>
                    {sync.data.config.lsp === false
                      ? "LSPs have been disabled in settings"
                      : "LSPs will activate as files are read"}
                  </text>
                </Show>
                <For each={sync.data.lsp}>
                  {(item) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: {
                            connected: theme.success,
                            error: theme.error,
                          }[item.status],
                        }}
                      >
                        •
                      </text>
                      <text fg={theme.textMuted}>
                        {item.id} {item.root}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
            <Show when={todo().length > 0 && todo().some((t) => t.status !== "completed")}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => todo().length > 2 && setExpanded("todo", !expanded.todo)}
                >
                  <Show when={todo().length > 2}>
                    <text fg={theme.text}>{expanded.todo ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Todo</b>
                  </text>
                </box>
                <Show when={todo().length <= 2 || expanded.todo}>
                  <For each={todo()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
                </Show>
              </box>
            </Show>
            {/* LLM Status Card */}
            <box>
              <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("llm", !expanded.llm)}>
                <text fg={theme.text}>{expanded.llm ? "▼" : "▶"}</text>
                <text fg={theme.text}>
                  <b>LLM</b>
                  <Show when={!expanded.llm}>
                    {(() => {
                      const m = local.model.current(props.sessionID)
                      if (!m) return <span style={{ fg: theme.textMuted }}> (No model)</span>
                      return (
                        <span style={{ fg: theme.textMuted }}>
                          {" "}
                          ({shortModel(m.modelID)} <span style={{ fg: theme.success }}>OK</span>)
                        </span>
                      )
                    })()}
                  </Show>
                </text>
              </box>
              <Show when={expanded.llm}>
                {(() => {
                  const currentModel = local.model.current(props.sessionID)
                  const history = llmHistory()
                  return (
                    <>
                      <Show when={history.length > 0} fallback={<text fg={theme.textMuted}>No recent events</text>}>
                        <For each={history}>
                          {(h) => {
                            // Resolve provider: bus events may use family ID or account ID;
                            // fall back to currentModel's providerId when history entry is missing it
                            const effectiveProvider = h.providerId || currentModel?.providerId || ""
                            const acct =
                              local.resolveAccountLabel(h.accountId, effectiveProvider) ??
                              (currentModel
                                ? local.resolveAccountLabel(currentModel.accountId, currentModel.providerId)
                                : undefined)
                            const acctSuffix = acct ? ` (${acct})` : ""
                            if (h.state === "rotated") {
                              const toAcct = local.resolveAccountLabel(h.toAccountId, h.toProviderId)
                              return (
                                <box>
                                  <box flexDirection="row">
                                    <text fg={theme.text} flexGrow={1} flexShrink={1} overflow="hidden" wrapMode="none">
                                      <span style={{ fg: theme.warning }}>•</span> {effectiveProvider}/{shortModel(h.modelId)}{acctSuffix}
                                    </text>
                                    <text flexShrink={0}> <span style={{ fg: theme.warning }}>RATE</span> <span style={{ fg: theme.textMuted }}>{formatTime(h.timestamp)}</span></text>
                                  </box>
                                  <text fg={theme.textMuted} overflow="hidden" wrapMode="none">
                                    {"  "}→ {h.toProviderId}/{shortModel(h.toModelId ?? h.modelId)}<Show when={toAcct}> ({toAcct})</Show>
                                  </text>
                                </box>
                              )
                            }
                            if (h.state === "recovered") {
                              return (
                                <box flexDirection="row">
                                  <text fg={theme.text} flexGrow={1} flexShrink={1} overflow="hidden" wrapMode="none">
                                    <span style={{ fg: theme.success }}>•</span> {effectiveProvider}/{shortModel(h.modelId)}{acctSuffix}
                                  </text>
                                  <text flexShrink={0}> <span style={{ fg: theme.success }}>OK</span> <span style={{ fg: theme.textMuted }}>{formatTime(h.timestamp)}</span></text>
                                </box>
                              )
                            }
                            // error / ratelimit / auth_failed
                            const stateColor = h.state === "auth_failed" ? theme.error : theme.warning
                            const stateLabel =
                              h.state === "auth_failed" ? "AUTH" : h.state === "ratelimit" ? "RATE" : "ERR"
                            return (
                              <box>
                                <box flexDirection="row">
                                  <text fg={theme.text} flexGrow={1} flexShrink={1} overflow="hidden" wrapMode="none">
                                    <span style={{ fg: stateColor }}>•</span> {effectiveProvider}/{shortModel(h.modelId)}{acctSuffix}
                                  </text>
                                  <text flexShrink={0}> <span style={{ fg: stateColor }}>{stateLabel}</span> <span style={{ fg: theme.textMuted }}>{formatTime(h.timestamp)}</span></text>
                                </box>
                                <Show when={h.message}>
                                  <text fg={theme.textMuted} overflow="hidden" wrapMode="none">
                                    {"  "}{h.message}
                                  </text>
                                </Show>
                              </box>
                            )
                          }}
                        </For>
                      </Show>
                    </>
                  )
                })()}
              </Show>
            </box>
            <box>
              <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("diff", !expanded.diff)}>
                <text fg={theme.text}>{expanded.diff ? "▼" : "▶"}</text>
                <text fg={theme.text}>
                  <b>Changes</b>
                  <span style={{ fg: theme.textMuted }}> {diff().length === 0 ? "(Clean)" : `(${diff().length})`}</span>
                </text>
              </box>
              <Show when={diff().length === 0 && expanded.diff}>
                <text fg={theme.textMuted}>No uncommitted workdir files</text>
              </Show>
              <Show when={diff().length > 0 && expanded.diff}>
                <For each={diff() || []}>
                  {(item) => {
                    return (
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted}>•</text>
                        <text fg={theme.textMuted} wrapMode="word">
                          {item.path}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </Show>
            </box>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <Show when={!hasProviders() && !gettingStartedDismissed()}>
            <box
              backgroundColor={theme.backgroundElement}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0} fg={theme.text}>
                ⬖
              </text>
              <box flexGrow={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <b>Getting started</b>
                  </text>
                  <text fg={theme.textMuted} onMouseDown={() => kv.set("dismissed_getting_started", true)}>
                    ✕
                  </text>
                </box>
                <text fg={theme.textMuted}>OpenCode includes free models so you can start immediately.</text>
                <text fg={theme.textMuted}>
                  Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
                </text>
                <box flexDirection="row" gap={1} justifyContent="space-between">
                  <text fg={theme.text}>Connect provider</text>
                  <text fg={theme.textMuted}>/connect</text>
                </box>
              </box>
            </box>
          </Show>
          <text>
            <span style={{ fg: theme.textMuted }}>{directory().split("/").slice(0, -1).join("/")}/</span>
            <span style={{ fg: theme.text }}>{directory().split("/").at(-1)}</span>
          </text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Open</b>
            <span style={{ fg: theme.text }}>
              <b>Code</b>
            </span>{" "}
            <span>{Installation.VERSION}</span>
          </text>
        </box>
      </box>
    </Show>
  )
}
