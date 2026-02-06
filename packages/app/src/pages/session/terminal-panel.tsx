import { createMemo, For, Show } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { SortableTerminalTab } from "@/components/session"
import { Terminal } from "@/components/terminal"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useLayout } from "@/context/layout"
import { createMediaQuery } from "@solid-primitives/media"

export function TerminalPanel(props: {
  view: ReturnType<ReturnType<typeof useLayout>["view"]>
  layout: ReturnType<typeof useLayout>
  terminal: ReturnType<typeof useTerminal>
  language: ReturnType<typeof useLanguage>
  command: ReturnType<typeof useCommand>
  handoff: string[]
  handleTerminalDragStart: (event: unknown) => void
  handleTerminalDragOver: (event: DragEvent) => void
  handleTerminalDragEnd: () => void
  onCloseTab: () => void
  activeTerminalDraggable: string | undefined
}) {
  const isDesktop = createMediaQuery("(min-width: 768px)")

  const label = (t: LocalPTY) => {
    const title = t.title
    return title || props.language.t("terminal.title")
  }

  return (
    <Show when={isDesktop() && props.view.terminal.opened()}>
      <div
        id="terminal-panel"
        role="region"
        aria-label={props.language.t("terminal.title")}
        class="relative w-full flex flex-col shrink-0 border-t border-border-weak-base"
        style={{ height: `${props.layout.terminal.height()}px` }}
      >
        <ResizeHandle
          direction="vertical"
          size={props.layout.terminal.height()}
          min={100}
          max={window.innerHeight * 0.6}
          collapseThreshold={50}
          onResize={props.layout.terminal.resize}
          onCollapse={props.view.terminal.close}
        />
        <Show
          when={props.terminal.ready()}
          fallback={
            <div class="flex flex-col h-full pointer-events-none">
              <div class="h-10 flex items-center gap-2 px-2 border-b border-border-weak-base bg-background-stronger overflow-hidden">
                <For each={props.handoff}>
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
                onChange={(id) => {
                  props.terminal.open(id)
                }}
                class="!h-auto !flex-none"
              >
                <Tabs.List class="h-10">
                  <SortableProvider ids={props.terminal.all().map((t: LocalPTY) => t.id)}>
                    <For each={props.terminal.all()}>
                      {(pty) => <SortableTerminalTab terminal={pty} onClose={props.onCloseTab} />}
                    </For>
                  </SortableProvider>
                  <div class="h-full flex items-center justify-center">
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
              <div class="flex-1 min-h-0 relative">
                <For each={props.terminal.all()}>
                  {(pty) => (
                    <div
                      id={`terminal-wrapper-${pty.id}`}
                      class="absolute inset-0"
                      classList={{
                        "pointer-events-none opacity-0": props.terminal.active() !== pty.id,
                      }}
                    >
                      <Terminal pty={pty} />
                    </div>
                  )}
                </For>
              </div>
            </div>
            <DragOverlay>
              <Show when={props.activeTerminalDraggable}>
                {(id) => {
                  const pty = createMemo(() => props.terminal.all().find((t: LocalPTY) => t.id === id()))
                  return (
                    <div class="relative px-3 h-10 flex items-center bg-background-stronger border-x border-t border-border-weak-base border-b-transparent rounded-t-md">
                      <div class="text-14-medium text-text-strong truncate max-w-40">{pty() ? label(pty()!) : ""}</div>
                    </div>
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
