import { For, createEffect, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { DirtyCountBubble } from "@/components/dirty-count-bubble"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useFile } from "@/context/file"
import type { SessionWorkflowChip } from "@/pages/session/helpers"
import { sendSessionReloadDebugBeacon } from "@/utils/debug-beacon"

/**
 * specs/frontend-session-lazyload R5: top-of-list sentinel. When `active`
 * (usually = historyMore && !historyLoading && userScrolled), an
 * IntersectionObserver watches this 1px div. On intersection it calls onEnter
 * and unobserves itself; re-arms automatically on the next mount cycle
 * (active toggling off+on unmounts+remounts the component).
 *
 * rootMargin of 400px gives the loader a ~2–3 viewport head start so the
 * spinner is already visible by the time the user reaches the top.
 */
function ScrollSpySentinel(props: { active: boolean; onEnter: () => void }): JSX.Element {
  let el: HTMLDivElement | undefined
  createEffect(() => {
    if (!props.active) return
    if (!el) return
    if (typeof IntersectionObserver === "undefined") return // SSR / test env
    let fired = false
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !fired) {
            fired = true
            props.onEnter()
            observer.disconnect()
          }
        }
      },
      { rootMargin: "400px 0px 0px 0px" },
    )
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })
  return (
    <div
      ref={el}
      data-component="scroll-spy-sentinel"
      style="height: 1px; width: 100%;"
      aria-hidden="true"
    />
  )
}

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

export function MessageTimeline(props: {
  mobileChanges: boolean
  mobileFallback: JSX.Element
  scroll: { overflow: boolean; bottom: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onAutoScrollUserIntent: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  isDesktop: boolean
  onScrollSpyScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  userScrolled: () => boolean
  showHeader: boolean
  centered: boolean
  title?: string
  dirtyCount?: number
  parentID?: string
  workflowChips?: SessionWorkflowChip[]
  arbitrationChips?: SessionWorkflowChip[]
  openTitleEditor: () => void
  closeTitleEditor: () => void
  saveTitleEditor: () => void | Promise<void>
  titleRef: (el: HTMLInputElement) => void
  titleState: {
    draft: string
    editing: boolean
    saving: boolean
    menuOpen: boolean
    pendingRename: boolean
  }
  onTitleDraft: (value: string) => void
  onTitleMenuOpen: (open: boolean) => void
  onTitlePendingRename: (value: boolean) => void
  onNavigateParent: () => void
  sessionID: string
  onDeleteSession: (sessionID: string) => void
  t: (key: string, vars?: Record<string, string | number | boolean>) => string
  setContentRef: (el: HTMLDivElement) => void
  turnStart: number
  onRenderEarlier: () => void
  historyMore: boolean
  historyLoading: boolean
  onLoadEarlier: () => void
  renderedUserMessages: UserMessage[]
  anchor: (id: string) => string
  onRegisterMessage: (el: HTMLDivElement, id: string) => void
  onUnregisterMessage: (id: string) => void
  onFirstTurnMount?: () => void
  lastUserMessageID?: string
  expanded: Record<string, boolean>
  onToggleExpanded: (id: string) => void
}) {
  const settings = useSettings()
  const sdk = useSDK()
  const file = useFile()

  const inlineImagePreview = (path: string) => {
    const content = file.get(path)?.content
    const error = file.get(path)?.error
    if (!content) return error ? { error } : undefined
    const mimeType = content.mimeType?.toLowerCase() ?? ""
    const isSvg = path.toLowerCase().endsWith(".svg") || mimeType.startsWith("image/svg+xml")
    if (!mimeType.startsWith("image/") && !isSvg) return { error: "File is not an image" }
    if (isSvg) {
      if (content.encoding === "base64") return { url: `data:image/svg+xml;base64,${content.content}` }
      return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content.content)}` }
    }
    if (content.encoding !== "base64") return { error: "Image content is not base64 encoded" }
    return { url: `data:${content.mimeType};base64,${content.content}` }
  }

  let touchGesture: number | undefined

  createEffect(() => {
    sendSessionReloadDebugBeacon({
      sdk,
      event: "message-timeline:render-state",
      sessionID: props.sessionID,
      payload: {
        mobileChanges: props.mobileChanges,
        renderedUserMessages: props.renderedUserMessages.map((message) => message.id),
        turnStart: props.turnStart,
        historyMore: props.historyMore,
        historyLoading: props.historyLoading,
      },
    })
  })

  return (
    <Show
      when={!props.mobileChanges}
      fallback={<div class="relative h-full overflow-hidden">{props.mobileFallback}</div>}
    >
      <div class="relative w-full h-full min-w-0">
        <div
          class="absolute left-1/2 -translate-x-1/2 bottom-[calc(var(--prompt-height,8rem)+32px)] z-[60] pointer-events-none transition-all duration-200 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100": props.scroll.overflow && !props.scroll.bottom,
            "opacity-0 translate-y-2 scale-95 pointer-events-none": !props.scroll.overflow || props.scroll.bottom,
          }}
        >
          <button
            class="pointer-events-auto size-8 flex items-center justify-center rounded-full bg-background-base border border-border-base shadow-sm text-text-base hover:bg-background-stronger transition-colors"
            onClick={props.onResumeScroll}
          >
            <Icon name="arrow-down-to-line" />
          </button>
        </div>
        <div
          ref={props.setScrollRef}
          onWheel={(e) => {
            const root = e.currentTarget
            const delta = normalizeWheelDelta({
              deltaY: e.deltaY,
              deltaMode: e.deltaMode,
              rootHeight: root.clientHeight,
            })
            if (!delta) return
            if (delta < 0) props.onAutoScrollUserIntent()
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchStart={(e) => {
            touchGesture = e.touches[0]?.clientY
          }}
          onTouchMove={(e) => {
            const next = e.touches[0]?.clientY
            const prev = touchGesture
            touchGesture = next
            if (next === undefined || prev === undefined) return

            const delta = prev - next
            if (!delta) return
            if (delta < 0) props.onAutoScrollUserIntent()

            const root = e.currentTarget
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchEnd={() => {
            touchGesture = undefined
          }}
          onTouchCancel={() => {
            touchGesture = undefined
          }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onScroll={(e) => {
            props.onScheduleScrollState(e.currentTarget)
            const hasGesture = props.hasScrollGesture()
            if (hasGesture) props.onAutoScrollHandleScroll()
            if (!hasGesture) return
            props.onMarkScrollGesture(e.currentTarget)
            if (props.isDesktop) props.onScrollSpyScroll()
          }}
          onClick={props.onAutoScrollInteraction}
          class="relative min-w-0 w-full h-full overflow-y-auto session-scroller"
          data-user-scrolling={props.userScrolled() ? "" : undefined}
          style={{ "--session-title-height": props.showHeader ? "40px" : "0px" }}
        >
          <div ref={props.setContentRef} class="min-w-0 w-full">
            <Show when={props.showHeader}>
              <div
                data-session-title
                classList={{
                  "sticky top-0 z-30 bg-background-stronger group/session-title": true,
                  "w-full": true,
                  "px-4 md:px-6": true,
                  "max-w-[1000px] mx-auto": props.centered,
                }}
              >
                <div class="h-10 w-full flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1 min-w-0 flex-1">
                    <Show when={props.parentID}>
                      <IconButton
                        tabIndex={-1}
                        icon="arrow-left"
                        variant="ghost"
                        onClick={props.onNavigateParent}
                        aria-label={props.t("common.goBack")}
                      />
                    </Show>
                    <Show when={props.title || props.titleState.editing}>
                      <Show
                        when={props.titleState.editing}
                        fallback={
                          <div class="flex min-w-0 items-center gap-2">
                            <h1
                              class="text-16-medium text-text-strong truncate min-w-0"
                              onDblClick={props.openTitleEditor}
                            >
                              {props.title}
                            </h1>
                            <Show when={(props.dirtyCount ?? 0) > 0}>
                              <DirtyCountBubble
                                count={props.dirtyCount ?? 0}
                                active
                                rounded="md"
                                interactiveGroup="session-title"
                              />
                            </Show>
                          </div>
                        }
                      >
                        <InlineInput
                          ref={props.titleRef}
                          value={props.titleState.draft}
                          disabled={props.titleState.saving}
                          class="text-16-medium text-text-strong grow-1 min-w-0"
                          onInput={(event) => props.onTitleDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.isComposing || event.keyCode === 229) return
                            event.stopPropagation()
                            if (event.key === "Enter") {
                              event.preventDefault()
                              void props.saveTitleEditor()
                              return
                            }
                            if (event.key === "Escape") {
                              event.preventDefault()
                              props.closeTitleEditor()
                            }
                          }}
                          onBlur={props.closeTitleEditor}
                        />
                      </Show>
                    </Show>
                  </div>
                  <Show when={props.sessionID}>
                    {(id) => (
                      <div class="shrink-0 flex items-center">
                        <DropdownMenu open={props.titleState.menuOpen} onOpenChange={props.onTitleMenuOpen}>
                          <Tooltip value={props.t("common.moreOptions")} placement="top">
                            <DropdownMenu.Trigger
                              as={IconButton}
                              icon="dot-grid"
                              variant="ghost"
                              class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                              aria-label={props.t("common.moreOptions")}
                            />
                          </Tooltip>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              onCloseAutoFocus={(event) => {
                                if (!props.titleState.pendingRename) return
                                event.preventDefault()
                                props.onTitlePendingRename(false)
                                props.openTitleEditor()
                              }}
                            >
                              <DropdownMenu.Item
                                onSelect={() => {
                                  props.onTitlePendingRename(true)
                                  props.onTitleMenuOpen(false)
                                }}
                              >
                                <DropdownMenu.ItemLabel>{props.t("common.rename")}</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                              <DropdownMenu.Separator />
                              <DropdownMenu.Item onSelect={() => props.onDeleteSession(id())}>
                                <DropdownMenu.ItemLabel>{props.t("common.delete")}</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </Show>

            <div
              role="log"
              class="flex flex-col gap-12 items-start justify-start pb-[calc(var(--prompt-height,8rem)+64px)] md:pb-[calc(var(--prompt-height,10rem)+64px)] transition-[margin]"
              classList={{
                "w-full": true,
                "max-w-[1000px] mx-auto": props.centered,
                "mt-0.5": props.centered,
                "mt-0": !props.centered,
              }}
            >
              <Show when={props.turnStart > 0}>
                <div class="w-full flex justify-center">
                  <Button
                    variant="ghost"
                    size="large"
                    class="text-12-medium opacity-50"
                    onClick={props.onRenderEarlier}
                  >
                    {props.t("session.messages.renderEarlier")}
                  </Button>
                </div>
              </Show>
              <Show when={props.historyMore}>
                {/* specs/frontend-session-lazyload R5: scroll-spy sentinel
                    that auto-calls onLoadEarlier when user scrolls near the
                    top. Gated by userScrolled() so follow-bottom mode does
                    not trigger accidental loads (INV-5 / DD-6). */}
                <ScrollSpySentinel
                  active={props.historyMore && !props.historyLoading && props.userScrolled()}
                  onEnter={props.onLoadEarlier}
                />
                <div class="w-full flex justify-center">
                  <Button
                    variant="ghost"
                    size="large"
                    class="text-12-medium opacity-50"
                    disabled={props.historyLoading}
                    onClick={props.onLoadEarlier}
                  >
                    {props.historyLoading
                      ? props.t("session.messages.loadingEarlier")
                      : props.t("session.messages.loadEarlier")}
                  </Button>
                </div>
              </Show>
              <For each={props.renderedUserMessages}>
                {(message) => {
                  onMount(() => {
                    sendSessionReloadDebugBeacon({
                      sdk,
                      event: "message-timeline:turn-mounted",
                      sessionID: props.sessionID,
                      messageID: message.id,
                      payload: {
                        lastUserMessageID: props.lastUserMessageID,
                        expanded: props.expanded[message.id] ?? false,
                      },
                    })
                  })

                  if (import.meta.env.DEV && props.onFirstTurnMount) {
                    onMount(() => props.onFirstTurnMount?.())
                  }

                  return (
                    <div
                      id={props.anchor(message.id)}
                      data-message-id={message.id}
                      ref={(el) => {
                        props.onRegisterMessage(el, message.id)
                        onCleanup(() => props.onUnregisterMessage(message.id))
                      }}
                      classList={{
                        "min-w-0 w-full max-w-full": true,
                        "max-w-[1000px]": props.centered,
                      }}
                    >
                      <SessionTurn
                        sessionID={props.sessionID}
                        messageID={message.id}
                        lastUserMessageID={props.lastUserMessageID}
                        shellToolDefaultOpen={settings.general.shellToolPartsExpanded()}
                        editToolDefaultOpen={settings.general.editToolPartsExpanded()}
                        showReasoningSummaries={settings.general.showReasoningSummaries()}
                        stepsExpanded={props.expanded[message.id] ?? false}
                        onStepsExpandedToggle={() => props.onToggleExpanded(message.id)}
                        inlineImage={{
                          load: (path) => file.load(path),
                          preview: inlineImagePreview,
                        }}
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
      </div>
    </Show>
  )
}
