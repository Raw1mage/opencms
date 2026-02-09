import { InputRenderable, RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTheme, selectedForeground } from "@tui/context/theme"
import { entries, filter, flatMap, groupBy, pipe, take } from "remeda"
import { batch, createEffect, createMemo, createSignal, For, Show, type JSX, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import * as fuzzysort from "fuzzysort"
import { isDeepEqual } from "remeda"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { Keybind } from "@/util/keybind"
import { Locale } from "@/util/locale"

export interface DialogSelectProps<T> {
  title: string
  placeholder?: string
  options: DialogSelectOption<T>[]
  ref?: (ref: DialogSelectRef<T>) => void
  onMove?: (option: DialogSelectOption<T>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: DialogSelectOption<T>) => void
  skipFilter?: boolean
  hideInput?: boolean
  hoverSelect?: boolean
  keybind?: {
    keybind?: Keybind.Info
    title: string
    disabled?: boolean
    label?: string
    hidden?: boolean
    onTrigger: (option: DialogSelectOption<T>) => void
  }[]
  current?: T
  keybindLayout?: "inline" | "columns"
}

export interface DialogSelectOption<T = any> {
  title: string
  value: T
  description?: string
  footer?: JSX.Element | string
  category?: string
  disabled?: boolean
  bg?: RGBA
  gutter?: JSX.Element
  truncate?: "ellipsis" | "none"
  onSelect?: (ctx: DialogContext) => void
}

export type DialogSelectRef<T> = {
  filter: string
  filtered: DialogSelectOption<T>[]
}

export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const [store, setStore] = createStore({
    selected: 0,
    filter: "",
    input: "keyboard" as "keyboard" | "mouse",
    searchMode: false, // Search mode is off by default - press "/" to enter
  })

  createEffect(
    on(
      () => props.current,
      (current) => {
        if (current) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            setStore("selected", currentIndex)
          }
        }
      },
    ),
  )

  let input: InputRenderable

  const filtered = createMemo(() => {
    if (props.skipFilter) return props.options.filter((x) => x.disabled !== true)
    const needle = store.filter.toLowerCase()
    const options = pipe(
      props.options,
      filter((x) => x.disabled !== true),
    )
    if (!needle) return options

    // prioritize title matches (weight: 2) over category matches (weight: 1).
    // users typically search by the item name, and not its category.
    const result = fuzzysort
      .go(needle, options, {
        keys: ["title", "category"],
        scoreFn: (r) => r[0].score * 2 + r[1].score,
      })
      .map((x) => x.obj)

    return result
  })

  // When the filter changes due to how TUI works, the mousemove might still be triggered
  // via a synthetic event as the layout moves underneath the cursor. This is a workaround to make sure the input mode remains keyboard
  // that the mouseover event doesn't trigger when filtering.
  createEffect(() => {
    filtered()
    setStore("input", "keyboard")
  })

  const grouped = createMemo(() => {
    const result = pipe(
      filtered(),
      groupBy((x) => x.category ?? ""),
      // mapValues((x) => x.sort((a, b) => a.title.localeCompare(b.title))),
      entries(),
    )
    return result
  })

  const flat = createMemo(() => {
    return pipe(
      grouped(),
      flatMap(([_, options]) => options),
    )
  })

  const dimensions = useTerminalDimensions()
  const height = createMemo(() =>
    Math.min(flat().length + grouped().length * 2 - 1, Math.floor(dimensions().height / 2) - 6),
  )

  const selected = createMemo(() => flat()[store.selected])

  createEffect(
    on([() => store.filter, () => props.current], ([filter, current]) => {
      setTimeout(() => {
        if (filter.length > 0) {
          moveTo(0, true)
        } else if (current) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            moveTo(currentIndex, true)
          }
        }
      }, 0)
    }),
  )

  function move(direction: number) {
    if (flat().length === 0) return
    let next = store.selected + direction
    if (next < 0) next = 0
    if (next >= flat().length) next = flat().length - 1
    moveTo(next)
  }

  function moveTo(next: number, center = false) {
    setStore("selected", next)
    const option = selected()
    if (option) props.onMove?.(option)
    if (!scroll) return
    const target = scroll.getChildren().find((child) => {
      return child.id === JSON.stringify(selected()?.value)
    })
    if (!target) return
    const y = target.y - scroll.y
    if (center) {
      const centerOffset = Math.floor(scroll.height / 2)
      scroll.scrollBy(y - centerOffset)
    } else {
      if (y >= scroll.height) {
        scroll.scrollBy(y - scroll.height + 1)
      }
      if (y < 0) {
        scroll.scrollBy(y)
        if (isDeepEqual(flat()[0].value, selected()?.value)) {
          scroll.scrollTo(0)
        }
      }
    }
  }

  // Track stack length at mount time to detect new dialogs pushed on top
  const initialStackLength = dialog.stack.length

  const keybind = useKeybind()
  useKeyboard((evt) => {
    // Skip if a dialog was pushed on top after this component mounted
    // This prevents Enter key from triggering the selected option when user is typing in a DialogPrompt
    if (dialog.stack.length > initialStackLength) return

    setStore("input", "keyboard")

    // "/" enters search mode
    if (!store.searchMode && evt.sequence === "/" && !props.hideInput) {
      evt.preventDefault()
      setStore("searchMode", true)
      setTimeout(() => input?.focus(), 1)
      return
    }

    // In search mode, only handle navigation and Esc
    if (store.searchMode) {
      // Esc exits search mode (and clears filter if any)
      if (evt.name === "escape") {
        evt.preventDefault()
        if (store.filter) {
          batch(() => {
            setStore("filter", "")
            props.onFilter?.("")
          })
        }
        setStore("searchMode", false)
        input?.blur()
        return
      }

      // Allow navigation in search mode
      if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
        move(-1)
        return
      }
      if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
        move(1)
        return
      }
      if (evt.name === "pageup") {
        move(-10)
        return
      }
      if (evt.name === "pagedown") {
        move(10)
        return
      }

      // Return exits search mode (without selecting)
      if (evt.name === "return") {
        evt.preventDefault()
        setStore("searchMode", false)
        input?.blur()
        return
      }

      // Skip other keybinds when in search mode
      return
    }

    // Normal mode: navigation
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) move(-1)
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) move(1)
    if (evt.name === "pageup") move(-10)
    if (evt.name === "pagedown") move(10)
    if (evt.name === "home") moveTo(0)
    if (evt.name === "end") moveTo(flat().length - 1)

    if (evt.name === "return") {
      const option = selected()
      if (option) {
        evt.preventDefault()
        evt.stopPropagation()
        if (option.onSelect) option.onSelect(dialog)
        props.onSelect?.(option)
      }
    }

    // Normal mode: keybinds
    for (const item of props.keybind ?? []) {
      if (item.disabled || !item.keybind) continue
      if (Keybind.match(item.keybind, keybind.parse(evt))) {
        const s = selected()
        // Always trigger keybind - let handler deal with null selection
        // This allows keybinds like "Add" to work even with empty lists
        evt.preventDefault()
        item.onTrigger(s as any)
      }
    }
  })

  let scroll: ScrollBoxRenderable | undefined
  const ref: DialogSelectRef<T> = {
    get filter() {
      return store.filter
    },
    get filtered() {
      return filtered()
    },
  }
  props.ref?.(ref)

  const keybinds = createMemo(() => props.keybind?.filter((x) => !x.disabled && x.keybind && !x.hidden) ?? [])
  const keybindTitleWidth = createMemo(() => Math.max(0, ...keybinds().map((x) => x.title.length)))

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={2}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={hover() ? theme.primary : undefined}
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseUp={() => dialog.clear()}
          >
            <text fg={hover() ? theme.selectedListItemText : theme.textMuted}>esc</text>
          </box>
        </box>
        <Show when={!props.hideInput}>
          <box paddingTop={1}>
            <Show when={store.searchMode} fallback={<text fg={theme.textMuted}>Press / to search</text>}>
              <input
                onInput={(e) => {
                  batch(() => {
                    setStore("filter", e)
                    props.onFilter?.(e)
                  })
                }}
                focusedBackgroundColor={theme.backgroundPanel}
                cursorColor={theme.primary}
                focusedTextColor={theme.textMuted}
                ref={(r) => {
                  input = r
                  // Only focus when entering search mode (handled by keyboard handler)
                }}
                placeholder={props.placeholder ?? "Search"}
              />
            </Show>
          </box>
        </Show>
      </box>
      <Show
        when={grouped().length > 0}
        fallback={
          <box paddingLeft={4} paddingRight={4} paddingTop={1}>
            <text fg={theme.textMuted}>No results found</text>
          </box>
        }
      >
        <scrollbox
          paddingLeft={1}
          paddingRight={0}
          scrollbarOptions={{ visible: false }}
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          maxHeight={height()}
        >
          <For each={grouped()}>
            {([category, options], index) => (
              <>
                <Show when={category}>
                  <box paddingTop={index() > 0 ? 1 : 0} paddingLeft={3}>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                      {category}
                    </text>
                  </box>
                </Show>
                <For each={options}>
                  {(option) => {
                    const active = createMemo(() => isDeepEqual(option.value, selected()?.value))
                    const current = createMemo(() => isDeepEqual(option.value, props.current))
                    return (
                      <box
                        id={JSON.stringify(option.value)}
                        flexDirection="row"
                        onMouseMove={() => {
                          if (props.hoverSelect === false) return
                          setStore("input", "mouse")
                        }}
                        onMouseUp={() => {
                          option.onSelect?.(dialog)
                          props.onSelect?.(option)
                        }}
                        onMouseOver={() => {
                          if (props.hoverSelect === false) return
                          if (store.input !== "mouse") return
                          const index = flat().findIndex((x) => isDeepEqual(x.value, option.value))
                          if (index === -1) return
                          moveTo(index)
                        }}
                        onMouseDown={() => {
                          const index = flat().findIndex((x) => isDeepEqual(x.value, option.value))
                          if (index === -1) return
                          moveTo(index)
                        }}
                        backgroundColor={active() ? (option.bg ?? theme.primary) : RGBA.fromInts(0, 0, 0, 0)}
                        paddingLeft={current() || option.gutter ? 1 : 3}
                        paddingRight={0}
                        gap={1}
                      >
                        <Option
                          title={option.title}
                          footer={option.footer}
                          description={option.description !== category ? option.description : undefined}
                          active={active()}
                          current={current()}
                          gutter={option.gutter}
                          truncate={option.truncate}
                        />
                      </box>
                    )
                  }}
                </For>
              </>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={keybinds().length} fallback={<box flexShrink={0} />}>
        <box paddingRight={2} paddingLeft={4} flexShrink={0} paddingTop={1}>
          <Show
            when={props.keybindLayout === "columns"}
            fallback={
              <box flexDirection="row" gap={2}>
                <For each={keybinds()}>
                  {(item) => (
                    <text>
                      <span style={{ fg: theme.text }}>
                        <b>{item.title}</b>{" "}
                      </span>
                      <span style={{ fg: theme.textMuted }}>{item.label ?? Keybind.toString(item.keybind)}</span>
                    </text>
                  )}
                </For>
              </box>
            }
          >
            <box flexDirection="column" gap={1}>
              <For each={keybinds()}>
                {(item) => {
                  const label = item.label ?? Keybind.toString(item.keybind)
                  const pad = Math.max(0, keybindTitleWidth() - item.title.length + 2)
                  const spacer = " ".repeat(pad)
                  return (
                    <text>
                      <span style={{ fg: theme.text }}>
                        <b>{item.title}</b>
                      </span>
                      <span style={{ fg: theme.text }}>{spacer}</span>
                      <span style={{ fg: theme.textMuted }}>{label}</span>
                    </text>
                  )
                }}
              </For>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}

function Option(props: {
  title: string
  description?: string
  active?: boolean
  current?: boolean
  footer?: JSX.Element | string
  gutter?: JSX.Element
  truncate?: "ellipsis" | "none"
  onMouseOver?: () => void
}) {
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const title = () => (props.truncate === "none" ? props.title : Locale.truncate(props.title, 61))

  return (
    <>
      <Show when={props.current}>
        <text flexShrink={0} fg={props.active ? fg : props.current ? theme.primary : theme.text} marginRight={0}>
          ●
        </text>
      </Show>
      <Show when={!props.current && props.gutter}>
        <box flexShrink={0} marginRight={0}>
          {props.gutter}
        </box>
      </Show>
      <text
        flexGrow={1}
        fg={props.active ? fg : props.current ? theme.primary : theme.text}
        attributes={props.active ? TextAttributes.BOLD : undefined}
        overflow="hidden"
        wrapMode={props.truncate === "none" ? "word" : "none"}
        paddingLeft={3}
      >
        {title()}
        <Show when={props.description}>
          <span style={{ fg: props.active ? fg : theme.textMuted }}> {props.description}</span>
        </Show>
      </text>
      <Show when={props.footer}>
        <box flexShrink={0}>
          <text fg={props.active ? fg : theme.textMuted}>{props.footer}</text>
        </box>
      </Show>
    </>
  )
}
