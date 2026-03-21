import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { findLast } from "@opencode-ai/util/array"
import { Markdown } from "@opencode-ai/ui/markdown"
import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { getSessionContextMetrics } from "./session-context-metrics"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import { createSessionContextFormatter } from "./session-context-format"
import type { SessionTelemetry } from "@/context/global-sync/types"
import {
  AccountQuotaReuseCard,
  PromptTelemetryCard,
  RoundSessionTelemetryCard,
} from "@/pages/session/session-telemetry-cards"
import { useGlobalSync } from "@/context/global-sync"
import { resolveTelemetryAccountLabel } from "@/pages/session/session-telemetry-ui"

interface SessionContextTabProps {
  messages: () => Message[]
  visibleUserMessages: () => UserMessage[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  info: () => ReturnType<ReturnType<typeof useSync>["session"]["get"]>
  telemetry?: () => SessionTelemetry | undefined
}

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

function Stat(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong">{props.value}</div>
    </div>
  )
}

type ContextCardKey = "summary" | "breakdown" | "prompt" | "promptTelemetry" | "roundTelemetry" | "quota"

function ContextCard(props: { title: string; marker: string; children: JSX.Element }) {
  return (
    <section class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-2">
      <div class="flex items-start gap-2 min-w-0">
        <span class="text-11-medium text-text-weak shrink-0">{props.marker}</span>
        <div class="min-w-0 flex-1">
          <div class="text-12-medium text-text-strong break-words">{props.title}</div>
        </div>
      </div>
      {props.children}
    </section>
  )
}

export function SessionContextTab(props: SessionContextTabProps) {
  const params = useParams()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const layout = useLayout()

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const metrics = createMemo(() => getSessionContextMetrics(props.messages(), sync.data.provider.all))
  const ctx = createMemo(() => metrics().context)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  const cost = createMemo(() => {
    return usd().format(metrics().totalCost)
  })

  const counts = createMemo(() => {
    const all = props.messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const msg = findLast(props.visibleUserMessages(), (m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.modelLabel
  })

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.input, props.messages().length, systemPrompt()],
      () => {
        const c = ctx()
        if (!c?.input) return []
        return estimateSessionContextBreakdown({
          messages: props.messages(),
          parts: sync.data.part as Record<string, Part[] | undefined>,
          input: c.input,
          systemPrompt: systemPrompt(),
        })
      },
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  const stats = [
    { label: "context.stats.session", value: () => props.info()?.title ?? params.id ?? "—" },
    { label: "context.stats.messages", value: () => counts().all.toLocaleString(language.intl()) },
    { label: "context.stats.provider", value: providerLabel },
    { label: "context.stats.model", value: modelLabel },
    { label: "context.stats.limit", value: () => formatter().number(ctx()?.limit) },
    { label: "context.stats.totalTokens", value: () => formatter().number(ctx()?.total) },
    { label: "context.stats.usage", value: () => formatter().percent(ctx()?.usage) },
    { label: "context.stats.inputTokens", value: () => formatter().number(ctx()?.input) },
    { label: "context.stats.outputTokens", value: () => formatter().number(ctx()?.output) },
    { label: "context.stats.reasoningTokens", value: () => formatter().number(ctx()?.reasoning) },
    {
      label: "context.stats.cacheTokens",
      value: () => `${formatter().number(ctx()?.cacheRead)} / ${formatter().number(ctx()?.cacheWrite)}`,
    },
    { label: "context.stats.userMessages", value: () => counts().user.toLocaleString(language.intl()) },
    { label: "context.stats.assistantMessages", value: () => counts().assistant.toLocaleString(language.intl()) },
    { label: "context.stats.totalCost", value: cost },
    { label: "context.stats.sessionCreated", value: () => formatter().time(props.info()?.time.created) },
    { label: "context.stats.lastActivity", value: () => formatter().time(ctx()?.message.time.created) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  const telemetry = createMemo(() => props.telemetry?.())
  const resolveAccountLabel = (accountId?: string, providerId?: string) =>
    resolveTelemetryAccountLabel(globalSync, accountId, providerId)

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined
  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = props.view()?.scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      props.view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => props.messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  const cards = createMemo(() => {
    const result: Array<{ key: ContextCardKey; content: JSX.Element }> = [
      {
        key: "summary",
        content: (
          <ContextCard title="Summary" marker="[S]">
            <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
              <For each={stats}>
                {(stat) => (
                  <Stat label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />
                )}
              </For>
            </div>
          </ContextCard>
        ),
      },
      {
        key: "breakdown",
        content: (
          <ContextCard title="Breakdown" marker="[B]">
            <Show
              when={breakdown().length > 0}
              fallback={<div class="text-12-regular text-text-weak">No context breakdown yet.</div>}
            >
              <div class="flex flex-col gap-2">
                <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
                  <For each={breakdown()}>
                    {(segment) => (
                      <div
                        class="h-full"
                        style={{
                          width: `${segment.width}%`,
                          "background-color": BREAKDOWN_COLOR[segment.key],
                        }}
                      />
                    )}
                  </For>
                </div>
                <div class="flex flex-wrap gap-x-3 gap-y-1">
                  <For each={breakdown()}>
                    {(segment) => (
                      <div class="flex items-center gap-1 text-11-regular text-text-weak">
                        <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
                        <div>{breakdownLabel(segment.key)}</div>
                        <div class="text-text-weaker">{segment.percent.toLocaleString(language.intl())}%</div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </ContextCard>
        ),
      },
      {
        key: "prompt",
        content: (
          <ContextCard title="Prompt" marker="[P]">
            <Show
              when={systemPrompt()}
              fallback={<div class="text-12-regular text-text-weak">No system prompt for this session.</div>}
            >
              {(prompt) => (
                <div class="rounded-md border border-border-weak-base bg-surface-panel px-2.5 py-2">
                  <Markdown text={prompt()} class="text-12-regular" />
                </div>
              )}
            </Show>
          </ContextCard>
        ),
      },
    ]

    if (telemetry()) {
      result.push({
        key: "promptTelemetry",
        content: <PromptTelemetryCard telemetry={telemetry()} />,
      })
      result.push({
        key: "roundTelemetry",
        content: <RoundSessionTelemetryCard telemetry={telemetry()} accountLabel={resolveAccountLabel} />,
      })
      result.push({
        key: "quota",
        content: <AccountQuotaReuseCard telemetry={telemetry()} accountLabel={resolveAccountLabel} />,
      })
    }

    const order = layout.contextSidebar.order()
    const orderIndex = new Map(order.map((key, index) => [key, index]))
    return result.sort((a, b) => (orderIndex.get(a.key) ?? 99) - (orderIndex.get(b.key) ?? 99))
  })

  const handleDragEnd = (event: DragEvent) => {
    const from = event.draggable?.id as ContextCardKey | undefined
    const to = event.droppable?.id as ContextCardKey | undefined
    if (!from || !to || from === to) return
    const current = [...layout.contextSidebar.order()]
    const fromIndex = current.indexOf(from)
    const toIndex = current.indexOf(to)
    if (fromIndex === -1 || toIndex === -1) return
    current.splice(toIndex, 0, current.splice(fromIndex, 1)[0]!)
    layout.contextSidebar.setOrder(current)
  }

  return (
    <div
      class="@container h-full overflow-y-auto no-scrollbar pb-10"
      ref={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 flex flex-col gap-3">
        <DragDropProvider onDragEnd={handleDragEnd} collisionDetector={closestCenter}>
          <DragDropSensors />
          <SortableProvider ids={cards().map((card) => card.key)}>
            <For each={cards()}>
              {(card) => <SortableContextCard id={card.key}>{card.content}</SortableContextCard>}
            </For>
          </SortableProvider>
        </DragDropProvider>
      </div>
    </div>
  )
}

function SortableContextCard(props: { id: ContextCardKey; children: JSX.Element }) {
  const sortable = createSortable(props.id)
  return (
    <div use:sortable classList={{ "opacity-40": sortable.isActiveDraggable }}>
      {props.children}
    </div>
  )
}
