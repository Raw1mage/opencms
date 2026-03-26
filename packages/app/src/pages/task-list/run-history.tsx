import { createEffect, createSignal, For, Show } from "solid-js"
import type { CronRunLogEntry, SessionMessage, SessionMessageWithParts } from "./api"
import { formatRelativeTime } from "./cron-utils"

type CronApi = {
  getRuns(id: string, limit?: number): Promise<CronRunLogEntry[]>
  getSessionMessages(sessionId: string): Promise<SessionMessage[]>
  getSessionMessage(sessionId: string, messageId: string): Promise<SessionMessageWithParts>
}

export function RunHistoryPanel(props: { jobId: string; api: CronApi }) {
  const [runs, setRuns] = createSignal<CronRunLogEntry[]>([])
  const [loading, setLoading] = createSignal(true)
  const [expandedRuns, setExpandedRuns] = createSignal<Set<string>>(new Set())
  const [conversations, setConversations] = createSignal<Record<string, SessionMessageWithParts[]>>({})
  const [loadingConversation, setLoadingConversation] = createSignal<Set<string>>(new Set())

  createEffect(() => {
    void (async () => {
      try {
        const data = await props.api.getRuns(props.jobId, 20)
        setRuns(data)
      } catch {
        // Silently ignore — non-critical
      } finally {
        setLoading(false)
      }
    })()
  })

  async function toggleExpand(run: CronRunLogEntry) {
    const s = new Set(expandedRuns())
    if (s.has(run.runId)) {
      s.delete(run.runId)
      setExpandedRuns(s)
      return
    }
    s.add(run.runId)
    setExpandedRuns(s)

    // If run has sessionId and we haven't fetched conversation yet, fetch it
    if (run.sessionId && !conversations()[run.runId]) {
      const loading = new Set(loadingConversation())
      loading.add(run.runId)
      setLoadingConversation(loading)
      try {
        const messages = await props.api.getSessionMessages(run.sessionId)
        // Fetch full messages with parts for each message
        const withParts = await Promise.all(
          messages.map((m) => props.api.getSessionMessage(run.sessionId!, m.id)),
        )
        setConversations((prev) => ({ ...prev, [run.runId]: withParts }))
      } catch {
        // Fall through to summary display
      } finally {
        const l = new Set(loadingConversation())
        l.delete(run.runId)
        setLoadingConversation(l)
      }
    }
  }

  function formatTime(ms: number) {
    const d = new Date(ms)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  function formatDate(ms: number) {
    const d = new Date(ms)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    if (isToday) return "Today"
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday"
    return d.toLocaleDateString([], { month: "short", day: "numeric" })
  }

  function extractTextFromParts(msg: SessionMessageWithParts): string {
    return msg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n")
  }

  return (
    <div class="px-3 py-2 max-h-[300px] overflow-y-auto">
      <Show when={loading()}>
        <p class="text-12-medium text-color-dimmed py-2">Loading runs...</p>
      </Show>
      <Show when={!loading() && runs().length === 0}>
        <p class="text-12-medium text-color-dimmed py-2 italic">No runs yet</p>
      </Show>
      <Show when={!loading() && runs().length > 0}>
        <div class="space-y-1">
          <For each={runs()}>
            {(run) => {
              const isExpanded = () => expandedRuns().has(run.runId)
              const hasContent = () => !!run.summary || !!run.sessionId
              const duration = () => run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : null
              const conv = () => conversations()[run.runId]
              const isLoadingConv = () => loadingConversation().has(run.runId)

              return (
                <div
                  classList={{
                    "rounded px-2.5 py-1.5 transition-colors": true,
                    "hover:bg-surface-raised-base-hover cursor-pointer": hasContent(),
                  }}
                  onClick={() => hasContent() && void toggleExpand(run)}
                >
                  {/* Run header row */}
                  <div class="flex items-center gap-2 text-12-medium">
                    <span
                      classList={{
                        "shrink-0 w-1.5 h-1.5 rounded-full": true,
                        "bg-green-400": run.status === "ok",
                        "bg-red-400": run.status === "error",
                        "bg-yellow-400": run.status === "skipped",
                        "bg-neutral-400": !run.status,
                      }}
                    />
                    <span class="text-color-dimmed tabular-nums shrink-0">
                      {formatDate(run.startedAtMs)} {formatTime(run.startedAtMs)}
                    </span>
                    <Show when={duration()}>
                      <span class="text-color-dimmed shrink-0">({duration()})</span>
                    </Show>
                    <Show when={run.error}>
                      <span class="text-red-400 truncate flex-1">{run.error}</span>
                    </Show>
                    <Show when={!run.error && !isExpanded() && run.summary}>
                      <span class="text-color-secondary truncate flex-1">{run.summary}</span>
                    </Show>
                    <Show when={hasContent()}>
                      <span class="text-color-dimmed text-11-medium shrink-0 ml-auto">
                        {isExpanded() ? "▾" : "▸"}
                      </span>
                    </Show>
                  </div>

                  {/* Expanded content */}
                  <Show when={isExpanded()}>
                    <div class="mt-2 ml-3.5 pl-3 border-l-2 border-accent-base/30">
                      <Show when={isLoadingConv()}>
                        <p class="text-12-medium text-color-dimmed py-1">Loading conversation...</p>
                      </Show>

                      <Show when={conv() && conv()!.length > 0}>
                        <div class="space-y-2">
                          <For each={conv()}>
                            {(msg) => {
                              const text = () => extractTextFromParts(msg)
                              return (
                                <Show when={text()}>
                                  <div class="text-13-medium">
                                    <span
                                      classList={{
                                        "text-11-medium px-1 py-0.5 rounded mr-1.5": true,
                                        "bg-accent-base/15 text-accent-base": msg.role === "user",
                                        "bg-green-500/15 text-green-400": msg.role === "assistant",
                                      }}
                                    >
                                      {msg.role === "user" ? "Prompt" : "AI"}
                                    </span>
                                    <span class="text-color-secondary whitespace-pre-wrap break-words">
                                      {text()}
                                    </span>
                                  </div>
                                </Show>
                              )
                            }}
                          </For>
                        </div>
                      </Show>

                      {/* Fallback to summary if no conversation loaded */}
                      <Show when={!isLoadingConv() && (!conv() || conv()!.length === 0) && run.summary}>
                        <p class="text-13-medium text-color-secondary whitespace-pre-wrap break-words">
                          {run.summary}
                        </p>
                      </Show>
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
