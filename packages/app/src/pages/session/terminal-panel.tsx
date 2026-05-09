import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis } from "@/utils/solid-dnd"
import { SortableTerminalTab } from "@/components/session"
import { Terminal } from "@/components/terminal"
import { useTerminal } from "@/context/terminal"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { terminalTabLabel } from "@/pages/session/terminal-label"

export function TerminalPanel(props: {
  open: boolean
  height: number
  resize: (value: number) => void
  close: () => void
  terminal: ReturnType<typeof useTerminal>
  language: ReturnType<typeof useLanguage>
  command: ReturnType<typeof useCommand>
  handoff: () => string[]
  activeTerminalDraggable: () => string | undefined
  handleTerminalDragStart: (event: unknown) => void
  handleTerminalDragOver: (event: DragEvent) => void
  handleTerminalDragEnd: () => void
  onCloseTab: () => void
}) {
  const all = createMemo(() => props.terminal.all())
  const ids = createMemo(() => all().map((pty) => pty.id))
  const byId = createMemo(() => new Map(all().map((pty) => [pty.id, { ...pty }])))
  const [popoutWindow, setPopoutWindow] = createSignal<Window | undefined>()
  const params = useParams()

  const closePopout = () => {
    const win = popoutWindow()
    if (win && !win.closed) win.close()
    setPopoutWindow(undefined)
  }

  const togglePopout = () => {
    const current = popoutWindow()
    if (current && !current.closed) {
      closePopout()
      return
    }

    const active = props.terminal.active()
    const basePath = params.id ? `/${params.dir}/session/${params.id}` : `/${params.dir}/session`
    const popoutURL = new URL(`${basePath}/terminal-popout`, window.location.origin)
    if (active) popoutURL.searchParams.set("pty", active)

    const width = Math.max(980, Math.floor(window.innerWidth * 0.62))
    const height = Math.max(620, Math.floor(window.innerHeight * 0.62))
    const left = Math.max(20, Math.floor(window.screenX + (window.outerWidth - width) / 2))
    const top = Math.max(20, Math.floor(window.screenY + (window.outerHeight - height) / 2))
    const features = `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
    const win = window.open(popoutURL.toString(), "opencode-terminal-popout", features)
    if (!win) return

    setPopoutWindow(win)
    win.focus()
  }

  createEffect(() => {
    const win = popoutWindow()
    if (!win) return

    const restoreInlineTerminal = () => {
      setPopoutWindow((current) => (current === win ? undefined : current))
      window.focus()
      document.getElementById("terminal-panel")?.scrollIntoView({ block: "end", behavior: "smooth" })
    }

    const onBeforeUnload = () => restoreInlineTerminal()
    win.addEventListener("beforeunload", onBeforeUnload)

    const timer = window.setInterval(() => {
      if (!win.closed) return
      restoreInlineTerminal()
    }, 400)

    onCleanup(() => {
      win.removeEventListener("beforeunload", onBeforeUnload)
      window.clearInterval(timer)
    })
  })

  onCleanup(() => {
    closePopout()
  })

  // Phase 5.4: when popped out, the source pane vacates the main layout
  // footprint — only the tabs row stays visible so the user can re-dock
  // via the pop-out toggle. The full-height body (and the prior
  // "Terminal popped out" placeholder) is hidden.
  const inlineHeight = createMemo(() => (popoutWindow() ? "auto" : `${props.height}px`))
  return (
    <Show when={props.open}>
      <div
        id="terminal-panel"
        role="region"
        aria-label={props.language.t("terminal.title")}
        class="relative w-full flex flex-col shrink-0 border-t border-border-weak-base"
        style={{ height: inlineHeight() }}
      >
        <ResizeHandle
          direction="vertical"
          size={props.height}
          min={100}
          max={typeof window === "undefined" ? 1000 : window.innerHeight * 0.6}
          collapseThreshold={50}
          onResize={props.resize}
          onCollapse={props.close}
        />
        <Show
          when={props.terminal.ready()}
          fallback={
            <div class="flex flex-col h-full pointer-events-none">
              <div class="h-10 flex items-center gap-2 px-2 border-b border-border-weak-base bg-background-stronger overflow-hidden">
                <For each={props.handoff()}>
                  {(title) => (
                    <div class="px-2 py-1 rounded-md bg-surface-base text-14-regular text-text-weak truncate max-w-40">
                      {title}
                    </div>
                  )}
                </For>
                <div class="flex-1" />
                <div class="text-text-weak pr-2">
                  {props.language.t("common.loading")}
                  {props.language.t("common.loading.ellipsis")}
                </div>
              </div>
              <div class="flex-1 flex items-center justify-center text-text-weak">
                {props.language.t("terminal.loading")}
              </div>
            </div>
          }
        >
          <DragDropProvider
            onDragStart={props.handleTerminalDragStart}
            onDragEnd={props.handleTerminalDragEnd}
            onDragOver={props.handleTerminalDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragYAxis />
            <div class="flex flex-col h-full">
              <Tabs
                variant="alt"
                value={props.terminal.active()}
                onChange={(id) => props.terminal.open(id)}
                class="!h-auto !flex-none"
              >
                <Tabs.List class="h-10">
                  <SortableProvider ids={ids()}>
                    <For each={ids()}>
                      {(id) => (
                        <Show when={byId().get(id)}>
                          {(pty) => (
                            <SortableTerminalTab
                              terminal={pty()}
                              onClose={() => {
                                props.close()
                                props.onCloseTab()
                              }}
                            />
                          )}
                        </Show>
                      )}
                    </For>
                  </SortableProvider>
                  <div class="h-full flex items-center justify-center">
                    <TooltipKeybind title="Pop out terminal" keybind="" class="flex items-center">
                      <IconButton
                        icon={popoutWindow() ? "layout-bottom-full" : "square-arrow-top-right"}
                        variant="ghost"
                        iconSize="large"
                        onClick={togglePopout}
                        aria-label="Pop out terminal"
                      />
                    </TooltipKeybind>
                    <TooltipKeybind
                      title={props.language.t("command.terminal.new")}
                      keybind={props.command.keybind("terminal.new")}
                      class="flex items-center"
                    >
                      <IconButton
                        icon="plus-small"
                        variant="ghost"
                        iconSize="large"
                        onClick={props.terminal.new}
                        aria-label={props.language.t("command.terminal.new")}
                      />
                    </TooltipKeybind>
                  </div>
                </Tabs.List>
              </Tabs>
              <Show when={!popoutWindow()}>
                <div class="flex-1 min-h-0 relative">
                  <Show when={props.terminal.active()} keyed>
                    {(id) => (
                      <Show when={byId().get(id)} keyed>
                        {(pty) => (
                          <div id={`terminal-wrapper-${id}`} class="absolute inset-0">
                            <Terminal
                              pty={pty}
                              onCleanup={props.terminal.update}
                              onConnectError={() => props.terminal.clone(id)}
                            />
                          </div>
                        )}
                      </Show>
                    )}
                  </Show>
                </div>
              </Show>
            </div>
            <DragOverlay>
              <Show when={props.activeTerminalDraggable()} keyed>
                {(draggedId) => {
                  return (
                    <Show when={byId().get(draggedId)} keyed>
                      {(t) => (
                        <div class="relative p-1 h-10 flex items-center bg-background-stronger text-14-regular">
                          {terminalTabLabel({
                            title: t.title,
                            titleNumber: t.titleNumber,
                            t: props.language.t as (
                              key: string,
                              vars?: Record<string, string | number | boolean>,
                            ) => string,
                          })}
                        </div>
                      )}
                    </Show>
                  )
                }}
              </Show>
            </DragOverlay>
          </DragDropProvider>
        </Show>
      </div>
    </Show>
  )
}
