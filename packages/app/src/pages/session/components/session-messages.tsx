import { For, Show, onMount, type Accessor } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { navMark } from "@/utils/perf"
import type { UserMessage } from "@opencode-ai/sdk/v2"

interface SessionMessagesProps {
  params: any
  info: Accessor<any>
  centered: Accessor<boolean>
  store: any
  setStore: (key: string, ...args: any[]) => void
  historyMore: Accessor<boolean>
  historyLoading: Accessor<boolean>
  language: any
  sync: any
  renderedUserMessages: Accessor<UserMessage[]>
  lastUserMessage: Accessor<UserMessage | undefined>
  autoScroll: any
  resumeScroll: () => void
  markScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  scheduleScrollSpy: (container: HTMLDivElement) => void
  anchor: (id: string) => string
  setScrollRef: (el: HTMLDivElement | undefined) => void
  touchGesture: number | undefined
  setTouchGesture: (v: number | undefined) => void
  navigate: (path: string) => void
}

export function SessionMessages(props: SessionMessagesProps) {
  return (
    <div class="relative w-full h-full min-w-0">
      <div
        class="absolute left-1/2 -translate-x-1/2 bottom-[calc(var(--prompt-height,8rem)+32px)] z-[60] pointer-events-none transition-all duration-200 ease-out"
        classList={{
          "opacity-100 translate-y-0 scale-100": props.autoScroll.userScrolled(),
          "opacity-0 translate-y-2 scale-95 pointer-events-none": !props.autoScroll.userScrolled(),
        }}
      >
        <button
          class="pointer-events-auto size-8 flex items-center justify-center rounded-full bg-background-base border border-border-base shadow-sm text-text-base hover:bg-background-stronger transition-colors"
          onClick={props.resumeScroll}
        >
          <Icon name="arrow-down-to-line" />
        </button>
      </div>
      <div
        ref={props.setScrollRef}
        onWheel={(e) => {
          const root = e.currentTarget
          const target = e.target instanceof Element ? e.target : undefined
          const nested = target?.closest("[data-scrollable]")
          if (!nested || nested === root) {
            props.markScrollGesture(root)
            return
          }

          if (!(nested instanceof HTMLElement)) {
            props.markScrollGesture(root)
            return
          }

          const max = nested.scrollHeight - nested.clientHeight
          if (max <= 1) {
            props.markScrollGesture(root)
            return
          }

          const delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * root.clientHeight : e.deltaY
          if (!delta) return

          if (delta < 0) {
            if (nested.scrollTop + delta <= 0) props.markScrollGesture(root)
            return
          }

          const remaining = max - nested.scrollTop
          if (delta > remaining) props.markScrollGesture(root)
        }}
        onTouchStart={(e) => {
          props.setTouchGesture(e.touches[0]?.clientY)
        }}
        onTouchMove={(e) => {
          const next = e.touches[0]?.clientY
          const prev = props.touchGesture
          props.setTouchGesture(next)
          if (next === undefined || prev === undefined) return

          const delta = prev - next
          if (!delta) return

          const root = e.currentTarget
          const target = e.target instanceof Element ? e.target : undefined
          const nested = target?.closest("[data-scrollable]")
          if (!nested || nested === root) {
            props.markScrollGesture(root)
            return
          }

          if (!(nested instanceof HTMLElement)) {
            props.markScrollGesture(root)
            return
          }

          const max = nested.scrollHeight - nested.clientHeight
          if (max <= 1) {
            props.markScrollGesture(root)
            return
          }

          if (delta < 0) {
            if (nested.scrollTop + delta <= 0) props.markScrollGesture(root)
            return
          }

          const remaining = max - nested.scrollTop
          if (delta > remaining) props.markScrollGesture(root)
        }}
        onTouchEnd={() => {
          props.setTouchGesture(undefined)
        }}
        onTouchCancel={() => {
          props.setTouchGesture(undefined)
        }}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return
          props.markScrollGesture(e.currentTarget)
        }}
        onScroll={(e) => {
          if (!props.hasScrollGesture()) return
          props.autoScroll.handleScroll()
          props.markScrollGesture(e.currentTarget)
          if (props.params.dir) props.scheduleScrollSpy(e.currentTarget)
        }}
        onClick={props.autoScroll.handleInteraction}
        class="relative min-w-0 w-full h-full overflow-y-auto session-scroller"
        style={{ "--session-title-height": props.info()?.title || props.info()?.parentID ? "40px" : "0px" }}
      >
        <Show when={props.info()?.title || props.info()?.parentID}>
          <div
            classList={{
              "sticky top-0 z-30 bg-background-stronger": true,
              "w-full": true,
              "px-4 md:px-6": true,
              "md:max-w-200 md:mx-auto 3xl:max-w-[1200px] 3xl:mx-auto 4xl:max-w-[1600px] 4xl:mx-auto 5xl:max-w-[1900px] 5xl:mx-auto":
                props.centered(),
            }}
          >
            <div class="h-10 flex items-center gap-1">
              <Show when={props.info()?.parentID}>
                <IconButton
                  tabIndex={-1}
                  icon="arrow-left"
                  variant="ghost"
                  onClick={() => {
                    props.navigate(`/${props.params.dir}/session/${props.info()?.parentID}`)
                  }}
                  aria-label={props.language.t("common.goBack")}
                />
              </Show>
              <Show when={props.info()?.title}>
                <h1 class="text-16-medium text-text-strong truncate">{props.info()?.title}</h1>
              </Show>
            </div>
          </div>
        </Show>

        <div
          ref={props.autoScroll.contentRef}
          role="log"
          class="flex flex-col gap-32 items-start justify-start pb-[calc(var(--prompt-height,8rem)+64px)] md:pb-[calc(var(--prompt-height,10rem)+64px)] transition-[margin]"
          classList={{
            "w-full": true,
            "md:max-w-200 md:mx-auto 3xl:max-w-[1200px] 3xl:mx-auto 4xl:max-w-[1600px] 4xl:mx-auto 5xl:max-w-[1900px] 5xl:mx-auto":
              props.centered(),
            "mt-0.5": props.centered(),
            "mt-0": !props.centered(),
          }}
        >
          <Show when={props.store.turnStart > 0}>
            <div class="w-full flex justify-center">
              <Button
                variant="ghost"
                size="large"
                class="text-12-medium opacity-50"
                onClick={() => props.setStore("turnStart", 0)}
              >
                {props.language.t("session.messages.renderEarlier")}
              </Button>
            </div>
          </Show>
          <Show when={props.historyMore()}>
            <div class="w-full flex justify-center">
              <Button
                variant="ghost"
                size="large"
                class="text-12-medium opacity-50"
                disabled={props.historyLoading()}
                onClick={() => {
                  const id = props.params.id
                  if (!id) return
                  props.setStore("turnStart", 0)
                  props.sync.session.history.loadMore(id)
                }}
              >
                {props.historyLoading()
                  ? props.language.t("session.messages.loadingEarlier")
                  : props.language.t("session.messages.loadEarlier")}
              </Button>
            </div>
          </Show>
          <For each={props.renderedUserMessages()}>
            {(message) => {
              if (import.meta.env.DEV) {
                onMount(() => {
                  const id = props.params.id
                  if (!id) return
                  navMark({ dir: props.params.dir, to: id, name: "session:first-turn-mounted" })
                })
              }

              return (
                <div
                  id={props.anchor(message.id)}
                  data-message-id={message.id}
                  classList={{
                    "min-w-0 w-full max-w-full": true,
                    "md:max-w-200 3xl:max-w-[1200px] 4xl:max-w-[1600px] 5xl:max-w-[1900px]": props.centered(),
                  }}
                >
                  <SessionTurn
                    sessionID={props.params.id!}
                    messageID={message.id}
                    lastUserMessageID={props.lastUserMessage()?.id}
                    stepsExpanded={props.store.expanded[message.id] ?? false}
                    onStepsExpandedToggle={() =>
                      props.setStore("expanded", message.id, (open: boolean | undefined) => !open)
                    }
                    classes={{
                      root: "min-w-0 w-full relative",
                      content: "flex flex-col justify-between !overflow-visible",
                      container: "w-full px-4 md:px-6",
                    }}
                  />
                </div>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}
