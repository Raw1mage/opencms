import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import {
  batch,
  createContext,
  Show,
  useContext,
  type JSX,
  type ParentProps,
  createEffect,
  createSignal,
  createMemo,
} from "solid-js"
import { useTheme } from "@tui/context/theme"
import { Renderable, RGBA } from "@opentui/core"
import { createStore } from "solid-js/store"
import { Clipboard } from "@tui/util/clipboard"
import { useToast } from "./toast"
import { debugCheckpoint } from "@/util/debug"

export function Dialog(
  props: ParentProps<{
    size?: "medium" | "large" | "xlarge"
    width?: number
    onClose: () => void
    closeOnBackdrop?: boolean
  }>,
) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const closeOnBackdrop = props.closeOnBackdrop ?? false

  return (
    <box
      onMouseUp={async () => {
        if (renderer.getSelection()) return
        if (!closeOnBackdrop) return
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      position="absolute"
      paddingTop={dimensions().height / 4}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        onMouseUp={async (e) => {
          if (renderer.getSelection()) return
          e.stopPropagation()
        }}
        width={props.width ?? (props.size === "xlarge" ? 90 : props.size === "large" ? 80 : 60)}
        maxWidth={dimensions().width - 2}
        backgroundColor={theme.backgroundPanel}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  )
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as {
      element: JSX.Element
      onClose?: () => void
    }[],
  })
  // Separate size signal to avoid triggering stack re-render when size changes
  const [size, setSize] = createSignal<"medium" | "large" | "xlarge">("medium")
  const [width, setWidth] = createSignal<number | undefined>(undefined)

  createEffect(() => {
    debugCheckpoint("dialog", "stack", { size: store.stack.length })
  })

  useKeyboard((evt) => {
    if (evt.name === "escape" && store.stack.length > 0) {
      const current = store.stack.at(-1)!
      debugCheckpoint("dialog", "escape close", { size: store.stack.length })
      current.onClose?.()
      setStore("stack", store.stack.slice(0, -1))
      evt.preventDefault()
      evt.stopPropagation()
      refocus()
    }
  })

  const renderer = useRenderer()
  let focus: Renderable | null
  function refocus() {
    setTimeout(() => {
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
    }, 1)
  }

  return {
    clear() {
      debugCheckpoint("dialog", "clear", { size: store.stack.length, stack: new Error().stack })
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      batch(() => {
        setSize("medium")
        setWidth(undefined)
        setStore("stack", [])
      })
      refocus()
    },
    push(input: any, onClose?: () => void) {
      debugCheckpoint("dialog", "push", { size: store.stack.length + 1, stack: new Error().stack })
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      setStore("stack", (s) => [...s, { element: input, onClose }])
    },
    pop() {
      if (store.stack.length === 0) return
      const current = store.stack.at(-1)!
      debugCheckpoint("dialog", "pop", { size: store.stack.length - 1, stack: new Error().stack })
      if (current.onClose) current.onClose()
      setStore("stack", (s) => s.slice(0, -1))
      if (store.stack.length === 0) refocus()
    },
    replace(input: any, onClose?: () => void) {
      debugCheckpoint("dialog", "replace", { size: 1, stack: new Error().stack })
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      setSize("medium")
      setWidth(undefined)
      setStore("stack", [
        {
          element: input,
          onClose,
        },
      ])
    },
    get stack() {
      return store.stack
    },
    get size() {
      return size()
    },
    get width() {
      return width()
    },
    setSize(newSize: "medium" | "large" | "xlarge") {
      setSize(newSize)
    },
    setWidth(newWidth: number | undefined) {
      setWidth(newWidth)
    },
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

// Helper component to render the dialog element with memoization
function DialogContent(props: { element: JSX.Element | (() => JSX.Element) }) {
  // Memoize the resolved element to prevent re-creation
  const resolved = createMemo(() => {
    const el = props.element
    return typeof el === "function" ? el() : el
  })
  return <>{resolved()}</>
}

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        onMouseUp={async () => {
          const text = renderer.getSelection()?.getSelectedText()
          if (text && text.length > 0) {
            await Clipboard.copy(text)
              .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
              .catch(toast.error)
            renderer.clearSelection()
          }
        }}
      >
        <Show when={value.stack.length}>
          <Dialog onClose={() => value.clear()} size={value.size} width={value.width} closeOnBackdrop={false}>
            <DialogContent element={value.stack.at(-1)!.element} />
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}
