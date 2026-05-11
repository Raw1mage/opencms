import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { createSortable } from "@thisbeyond/solid-dnd"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Tabs } from "@opencode-ai/ui/tabs"
import { getFilename } from "@opencode-ai/util/path"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"

export function FileVisual(props: { path: string; active?: boolean }): JSX.Element {
  return (
    <div class="flex items-center gap-x-1.5 min-w-0">
      <Show
        when={!props.active}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        <span class="relative inline-flex size-4 shrink-0">
          <FileIcon node={{ path: props.path, type: "file" }} class="absolute inset-0 size-4 tab-fileicon-color" />
          <FileIcon node={{ path: props.path, type: "file" }} mono class="absolute inset-0 size-4 tab-fileicon-mono" />
        </span>
      </Show>
      <span class="text-14-medium truncate">{getFilename(props.path)}</span>
    </div>
  )
}

export function SortableTab(props: {
  tab: string
  onTabClose: (tab: string) => void
  onCloseOthers?: (tab: string) => void
  onCloseAll?: () => void
}): JSX.Element {
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const sortable = createSortable(props.tab)
  const path = createMemo(() => file.pathFromTab(props.tab))
  const content = createMemo(() => {
    const value = path()
    if (!value) return
    return <FileVisual path={value} />
  })

  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null)
  const closeMenu = () => setMenu(null)

  const onContext = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  createEffect(() => {
    if (!menu()) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target && target.closest("[data-slot='tab-context-menu']")) return
      closeMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu()
    }
    window.addEventListener("mousedown", onDown, true)
    window.addEventListener("keydown", onKey)
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown, true)
      window.removeEventListener("keydown", onKey)
    })
  })

  return (
    <div use:sortable class="h-full flex items-center" classList={{ "opacity-0": sortable.isActiveDraggable }}>
      <div class="relative">
        <Tabs.Trigger
          value={props.tab}
          closeButton={
            <TooltipKeybind
              title={language.t("common.closeTab")}
              keybind={command.keybind("tab.close")}
              placement="bottom"
              gutter={10}
            >
              <IconButton
                icon="close-small"
                variant="ghost"
                class="h-5 w-5"
                onClick={() => props.onTabClose(props.tab)}
                aria-label={language.t("common.closeTab")}
              />
            </TooltipKeybind>
          }
          hideCloseButton
          onContextMenu={onContext}
          onMiddleClick={() => props.onTabClose(props.tab)}
        >
          <Show when={content()}>{(value) => value()}</Show>
        </Tabs.Trigger>
        <Show when={menu()}>
          {(pos) => (
            <Portal>
              <div
                data-slot="tab-context-menu"
                class="fixed z-[1000] min-w-[10rem] rounded-md border-2 border-slate-700 bg-slate-900 py-1 shadow-lg text-12-medium text-text-base"
                style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
              >
                <button
                  type="button"
                  class="w-full text-left px-3 py-1.5 hover:bg-surface-tertiary"
                  onClick={() => {
                    closeMenu()
                    props.onTabClose(props.tab)
                  }}
                >
                  Close
                </button>
                <Show when={props.onCloseOthers}>
                  <button
                    type="button"
                    class="w-full text-left px-3 py-1.5 hover:bg-surface-tertiary"
                    onClick={() => {
                      closeMenu()
                      props.onCloseOthers?.(props.tab)
                    }}
                  >
                    Close others
                  </button>
                </Show>
                <Show when={props.onCloseAll}>
                  <button
                    type="button"
                    class="w-full text-left px-3 py-1.5 hover:bg-surface-tertiary"
                    onClick={() => {
                      closeMenu()
                      props.onCloseAll?.()
                    }}
                  >
                    Close all
                  </button>
                </Show>
              </div>
            </Portal>
          )}
        </Show>
      </div>
    </div>
  )
}
