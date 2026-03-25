import type { Ghostty, Terminal as Term, FitAddon } from "ghostty-web"
import { ComponentProps, createEffect, createSignal, onCleanup, onMount, splitProps } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { monoFontFamily, useSettings } from "@/context/settings"
import { parseKeybind, matchKeybind } from "@/context/command"
import { SerializeAddon } from "@/addons/serialize"
import { LocalPTY } from "@/context/terminal"
import { resolveThemeVariant, useTheme, withAlpha, type HexColor } from "@opencode-ai/ui/theme"
import { useLanguage } from "@/context/language"
import { showToast } from "@opencode-ai/ui/toast"
import { disposeIfDisposable, getHoveredLinkText, setOptionIfSupported } from "@/utils/runtime-adapters"
import { terminalWriter } from "@/utils/terminal-writer"

const TOGGLE_TERMINAL_ID = "terminal.toggle"
const DEFAULT_TOGGLE_TERMINAL_KEYBIND = "ctrl+`"
export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  onSubmit?: () => void
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
  onConnect?: () => void
  onConnectError?: (error: unknown) => void
  autoCopyOnSelect?: boolean
  contextMenuCopiesSelection?: boolean
  ignoreStoredViewport?: boolean
  clearSelectionOnInput?: boolean
}

let shared: Promise<{ mod: typeof import("ghostty-web"); ghostty: Ghostty }> | undefined

const loadGhostty = () => {
  if (shared) return shared
  shared = import("ghostty-web")
    .then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
    .catch((err) => {
      shared = undefined
      throw err
    })
  return shared
}

type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors> = {
  light: {
    background: "#fcfcfc",
    foreground: "#211e1e",
    cursor: "#211e1e",
    selectionBackground: withAlpha("#211e1e", 0.2),
  },
  dark: {
    background: "#191515",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: withAlpha("#d4d4d4", 0.25),
  },
}

const debugTerminal = (...values: unknown[]) => {
  if (!import.meta.env.DEV) return
  console.debug("[terminal]", ...values)
}

const copyTextToClipboard = async (doc: Document, text: string) => {
  const normalized = text
  if (!normalized) return false

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(normalized)
      return true
    }
  } catch {
    // fallback below
  }

  try {
    const textarea = doc.createElement("textarea")
    textarea.value = normalized
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    doc.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = doc.execCommand("copy")
    textarea.remove()
    return ok
  } catch {
    return false
  }
}

const useTerminalUiBindings = (input: {
  container: HTMLDivElement
  term: Term
  cleanups: VoidFunction[]
  handlePointerDown: (event: PointerEvent) => void
  handleLinkClick: (event: MouseEvent) => void
  autoCopyOnSelect?: boolean
  contextMenuCopiesSelection?: boolean
  clearSelectionOnInput?: boolean
}) => {
  const clearAllSelection = () => {
    const runtime = input.term as unknown as { clearSelection?: () => void }
    runtime.clearSelection?.()
    input.container.ownerDocument.getSelection()?.removeAllRanges()
  }

  const pickSelection = () => {
    const termSelection = input.term.getSelection()?.trim() ?? ""
    if (termSelection) return termSelection
    const browserSelection = input.container.ownerDocument.getSelection()?.toString().trim() ?? ""
    return browserSelection
  }

  const handleCopy = (event: ClipboardEvent) => {
    const selection = pickSelection()
    if (!selection) return

    const clipboard = event.clipboardData
    if (!clipboard) return

    event.preventDefault()
    clipboard.setData("text/plain", selection)
  }

  const handlePaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData
    const text = clipboard?.getData("text/plain") ?? clipboard?.getData("text") ?? ""
    if (!text) return

    event.preventDefault()
    event.stopPropagation()
    clearAllSelection()
    input.term.paste(text)
    queueMicrotask(() => clearAllSelection())
  }

  const handleTextareaFocus = () => {
    input.term.options.cursorBlink = true
  }
  const handleTextareaBlur = () => {
    input.term.options.cursorBlink = false
  }

  input.container.addEventListener("copy", handleCopy, true)
  input.cleanups.push(() => input.container.removeEventListener("copy", handleCopy, true))
  input.container.ownerDocument.addEventListener("copy", handleCopy, true)
  input.cleanups.push(() => input.container.ownerDocument.removeEventListener("copy", handleCopy, true))

  input.container.addEventListener("paste", handlePaste, true)
  input.cleanups.push(() => input.container.removeEventListener("paste", handlePaste, true))

  input.container.addEventListener("pointerdown", input.handlePointerDown)
  input.cleanups.push(() => input.container.removeEventListener("pointerdown", input.handlePointerDown))

  input.container.addEventListener("click", input.handleLinkClick, { capture: true })
  input.cleanups.push(() => input.container.removeEventListener("click", input.handleLinkClick, { capture: true }))

  const copySelectedNow = async () => {
    const doc = input.container.ownerDocument
    const selected = pickSelection()
    if (!selected) return false

    // Prefer native copy command in direct user gesture.
    const ok = doc.execCommand("copy")
    if (ok) return true
    return copyTextToClipboard(doc, selected)
  }

  if (input.autoCopyOnSelect) {
    const handleMouseUp = () => {
      queueMicrotask(() => {
        void copySelectedNow()
      })
    }
    input.container.ownerDocument.addEventListener("mouseup", handleMouseUp, true)
    input.cleanups.push(() => input.container.ownerDocument.removeEventListener("mouseup", handleMouseUp, true))
  }

  if (input.contextMenuCopiesSelection) {
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && !input.container.contains(target)) return
      const selected = pickSelection()
      if (!selected) return
      event.preventDefault()
      void copySelectedNow().finally(() => {
        clearAllSelection()
      })
    }
    input.container.ownerDocument.addEventListener("contextmenu", handleContextMenu, true)
    input.cleanups.push(() => input.container.ownerDocument.removeEventListener("contextmenu", handleContextMenu, true))
  }

  if (input.clearSelectionOnInput) {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Node | null
      if (target && !input.container.contains(target)) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key.length === 1 || event.key === "Enter" || event.key === "Backspace" || event.key === "Delete") {
        clearAllSelection()
      }
    }
    input.container.ownerDocument.addEventListener("keydown", handleKeyDown, true)
    input.cleanups.push(() => input.container.ownerDocument.removeEventListener("keydown", handleKeyDown, true))
  }

  input.term.textarea?.addEventListener("focus", handleTextareaFocus)
  input.term.textarea?.addEventListener("blur", handleTextareaBlur)
  input.cleanups.push(() => input.term.textarea?.removeEventListener("focus", handleTextareaFocus))
  input.cleanups.push(() => input.term.textarea?.removeEventListener("blur", handleTextareaBlur))
}

const persistTerminal = (input: {
  term: Term | undefined
  addon: SerializeAddon | undefined
  cursor: number
  id: string
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
}) => {
  if (!input.addon || !input.onCleanup || !input.term) return
  const buffer = (() => {
    try {
      return input.addon.serialize()
    } catch {
      debugTerminal("failed to serialize terminal buffer")
      return ""
    }
  })()

  input.onCleanup({
    id: input.id,
    buffer,
    cursor: input.cursor,
    rows: input.term.rows,
    cols: input.term.cols,
    scrollY: input.term.getViewportY(),
  })
}

const clearTerminalSurface = (term: Term) => {
  const runtime = term as unknown as {
    clear?: () => void
    reset?: () => void
  }
  runtime.clear?.()
  runtime.reset?.()
}

const resetTerminalContainer = (container: HTMLDivElement) => {
  // Hard-reset DOM host to avoid previous tab frame bleed when mounting a new PTY.
  // This protects against renderer remnants surviving quick tab switches/new-tab create.
  container.replaceChildren()
}

export const Terminal = (props: TerminalProps) => {
  const platform = usePlatform()
  const sdk = useSDK()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, [
    "pty",
    "class",
    "classList",
    "onConnect",
    "onConnectError",
    "autoCopyOnSelect",
    "contextMenuCopiesSelection",
    "ignoreStoredViewport",
    "clearSelectionOnInput",
  ])
  const id = local.pty.id
  const restore = typeof local.pty.buffer === "string" ? local.pty.buffer : ""
  const restoreSize = local.ignoreStoredViewport
    ? undefined
    : restore &&
        typeof local.pty.cols === "number" &&
        Number.isSafeInteger(local.pty.cols) &&
        local.pty.cols > 0 &&
        typeof local.pty.rows === "number" &&
        Number.isSafeInteger(local.pty.rows) &&
        local.pty.rows > 0
      ? { cols: local.pty.cols, rows: local.pty.rows }
      : undefined
  const scrollY = typeof local.pty.scrollY === "number" ? local.pty.scrollY : undefined
  let ws: WebSocket | undefined
  let term: Term | undefined
  let ghostty: Ghostty
  let serializeAddon: SerializeAddon
  let fitAddon: FitAddon
  let handleResize: () => void
  let fitFrame: number | undefined
  let sizeTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSize: { cols: number; rows: number } | undefined
  let lastSize: { cols: number; rows: number } | undefined
  let disposed = false
  const cleanups: VoidFunction[] = []
  const start =
    typeof local.pty.cursor === "number" && Number.isSafeInteger(local.pty.cursor) ? local.pty.cursor : undefined
  let cursor = start ?? 0
  let output: ReturnType<typeof terminalWriter> | undefined

  const cleanup = () => {
    if (!cleanups.length) return
    const fns = cleanups.splice(0).reverse()
    for (const fn of fns) {
      try {
        fn()
      } catch (err) {
        debugTerminal("cleanup failed", err)
      }
    }
  }

  const pushSize = (cols: number, rows: number) => {
    return sdk.client.pty
      .update({
        ptyID: id,
        size: { cols, rows },
      })
      .catch((err) => {
        debugTerminal("failed to sync terminal size", err)
      })
  }

  const getTerminalColors = (): TerminalColors => {
    const mode = theme.mode() === "dark" ? "dark" : "light"
    const fallback = DEFAULT_TERMINAL_COLORS[mode]
    const currentTheme = theme.themes()[theme.themeId()]
    if (!currentTheme) return fallback
    const variant = mode === "dark" ? currentTheme.dark : currentTheme.light
    if (!variant?.seeds) return fallback
    const resolved = resolveThemeVariant(variant, mode === "dark")
    const text = resolved["text-stronger"] ?? fallback.foreground
    const background = resolved["background-stronger"] ?? fallback.background
    const alpha = mode === "dark" ? 0.25 : 0.2
    const base = text.startsWith("#") ? (text as HexColor) : (fallback.foreground as HexColor)
    const selectionBackground = withAlpha(base, alpha)
    return {
      background,
      foreground: text,
      cursor: text,
      selectionBackground,
    }
  }

  const [terminalColors, setTerminalColors] = createSignal<TerminalColors>(getTerminalColors())

  const scheduleFit = () => {
    if (disposed) return
    if (!fitAddon) return
    if (fitFrame !== undefined) return

    fitFrame = requestAnimationFrame(() => {
      fitFrame = undefined
      if (disposed) return
      fitAddon.fit()
    })
  }

  const scheduleSize = (cols: number, rows: number) => {
    if (disposed) return
    if (lastSize?.cols === cols && lastSize?.rows === rows) return

    pendingSize = { cols, rows }

    if (!lastSize) {
      lastSize = pendingSize
      void pushSize(cols, rows)
      return
    }

    if (sizeTimer !== undefined) return
    sizeTimer = setTimeout(() => {
      sizeTimer = undefined
      const next = pendingSize
      if (!next) return
      pendingSize = undefined
      if (disposed) return
      if (lastSize?.cols === next.cols && lastSize?.rows === next.rows) return
      lastSize = next
      void pushSize(next.cols, next.rows)
    }, 100)
  }

  createEffect(() => {
    const colors = getTerminalColors()
    setTerminalColors(colors)
    if (!term) return
    setOptionIfSupported(term, "theme", colors)
  })

  createEffect(() => {
    const font = monoFontFamily(settings.appearance.font())
    if (!term) return
    setOptionIfSupported(term, "fontFamily", font)
    scheduleFit()
  })

  let zoom = platform.webviewZoom?.()
  createEffect(() => {
    const next = platform.webviewZoom?.()
    if (next === undefined) return
    if (next === zoom) return
    zoom = next
    scheduleFit()
  })

  const focusTerminal = () => {
    const t = term
    if (!t) return
    t.focus()
    t.textarea?.focus()
    setTimeout(() => t.textarea?.focus(), 0)
  }

  const handlePointerDown = (event: PointerEvent) => {
    const doc = container.ownerDocument

    const activeElement = doc.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== container && !container.contains(activeElement)) {
      activeElement.blur()
    }
    focusTerminal()
  }

  const handleLinkClick = (event: MouseEvent) => {
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return
    if (event.altKey) return
    if (event.button !== 0) return

    const t = term
    if (!t) return

    const text = getHoveredLinkText(t)
    if (!text) return

    event.preventDefault()
    event.stopImmediatePropagation()
    platform.openLink(text)
  }

  onMount(() => {
    const run = async () => {
      let loaded: Awaited<ReturnType<typeof loadGhostty>>
      try {
        loaded = await loadGhostty()
      } catch (err) {
        local.onConnectError?.(err)
        return
      }
      if (disposed) return

      const mod = loaded.mod
      const g = loaded.ghostty

      const once = { value: false }

      const t = new mod.Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        cols: restoreSize?.cols,
        rows: restoreSize?.rows,
        fontSize: 14,
        fontFamily: monoFontFamily(settings.appearance.font()),
        allowTransparency: false,
        convertEol: false,
        theme: terminalColors(),
        scrollback: 10_000,
        ghostty: g,
      })
      cleanups.push(() => t.dispose())
      if (disposed) {
        cleanup()
        return
      }
      ghostty = g
      term = t
      resetTerminalContainer(container)
      output = terminalWriter((data, done) => t.write(data, done))

      t.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase()

        const browserSelection = container.ownerDocument.getSelection()?.toString() ?? ""
        const hasSelection = !!t.getSelection() || browserSelection.length > 0

        // In browser/popout mode, allow familiar copy shortcut when text is selected.
        if (!event.shiftKey && !event.altKey && !event.metaKey && event.ctrlKey && key === "c" && hasSelection) {
          document.execCommand("copy")
          return false
        }

        if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "c") {
          document.execCommand("copy")
          return true
        }

        // allow for toggle terminal keybinds in parent
        const config = settings.keybinds.get(TOGGLE_TERMINAL_ID) ?? DEFAULT_TOGGLE_TERMINAL_KEYBIND
        const keybinds = parseKeybind(config)

        return matchKeybind(keybinds, event)
      })

      const fit = new mod.FitAddon()
      const serializer = new SerializeAddon()
      cleanups.push(() => disposeIfDisposable(fit))
      t.loadAddon(serializer)
      t.loadAddon(fit)
      fitAddon = fit
      serializeAddon = serializer

      const forceFit = () => {
        fit.fit()
        scheduleSize(t.cols, t.rows)
      }

      t.open(container)
      forceFit()
      requestAnimationFrame(forceFit)
      setTimeout(forceFit, 0)
      setTimeout(forceFit, 60)
      setTimeout(forceFit, 140)
      useTerminalUiBindings({
        container,
        term: t,
        cleanups,
        handlePointerDown,
        handleLinkClick,
        autoCopyOnSelect: local.autoCopyOnSelect,
        contextMenuCopiesSelection: local.contextMenuCopiesSelection,
        clearSelectionOnInput: local.clearSelectionOnInput,
      })

      focusTerminal()

      if (typeof document !== "undefined" && document.fonts) {
        document.fonts.ready.then(forceFit)
      }

      const onResize = t.onResize((size) => {
        scheduleSize(size.cols, size.rows)
      })
      cleanups.push(() => disposeIfDisposable(onResize))
      const onData = t.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      })
      cleanups.push(() => disposeIfDisposable(onData))
      const onKey = t.onKey((key) => {
        if (key.key == "Enter") {
          props.onSubmit?.()
        }
      })
      cleanups.push(() => disposeIfDisposable(onKey))

      const startResize = () => {
        fit.observeResize()
        const observer = new ResizeObserver(() => {
          forceFit()
        })
        observer.observe(container)
        cleanups.push(() => observer.disconnect())
        handleResize = scheduleFit
        window.addEventListener("resize", handleResize)
        cleanups.push(() => window.removeEventListener("resize", handleResize))
      }

      if (restore && restoreSize) {
        t.write(restore, () => {
          forceFit()
          if (scrollY !== undefined) t.scrollToLine(scrollY)
          startResize()
        })
      } else {
        // FIX: avoid ghost frame bleed when mounting a fresh terminal tab (@event_20260223_web_architecture_first_plan)
        clearTerminalSurface(t)
        forceFit()
        if (restore) {
          t.write(restore, () => {
            if (scrollY !== undefined) t.scrollToLine(scrollY)
          })
        }
        startResize()
      }

      // t.onScroll((ydisp) => {
      // console.log("Scroll position:", ydisp)
      // })

      const url = new URL(sdk.url + `/pty/${id}/connect`)
      url.searchParams.set("directory", sdk.directory)
      url.searchParams.set(
        "cursor",
        String(local.ignoreStoredViewport ? 0 : start !== undefined ? start : restore ? -1 : 0),
      )
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      const socket = new WebSocket(url)
      socket.binaryType = "arraybuffer"
      ws = socket
      cleanups.push(() => {
        if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close(1000)
      })
      if (disposed) {
        cleanup()
        return
      }

      const handleOpen = () => {
        local.onConnect?.()
        scheduleSize(t.cols, t.rows)
      }
      socket.addEventListener("open", handleOpen)
      cleanups.push(() => socket.removeEventListener("open", handleOpen))

      if (socket.readyState === WebSocket.OPEN) handleOpen()

      const decoder = new TextDecoder()

      const writeIncoming = (chunk: string) => {
        if (!chunk) return
        t.write(chunk)
        cursor += chunk.length
      }

      const handleMessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
        if (disposed) return
        if (event.data instanceof ArrayBuffer) {
          // WebSocket control frame: 0x00 + UTF-8 JSON (currently { cursor }).
          const bytes = new Uint8Array(event.data)
          if (bytes[0] === 0) {
            const json = decoder.decode(bytes.subarray(1))
            try {
              const meta = JSON.parse(json) as { cursor?: unknown }
              const next = meta?.cursor
              if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
                cursor = next
              }
            } catch (err) {
              debugTerminal("invalid websocket control frame", err)
            }
            return
          }

          // FIX: handle PTY payload frames delivered as binary chunks (@event_20260223_web_architecture_first_plan)
          writeIncoming(decoder.decode(bytes))
          return
        }

        if (event.data instanceof Blob) {
          void event.data
            .text()
            .then((chunk) => writeIncoming(chunk))
            .catch((err) => debugTerminal("failed to decode terminal blob frame", err))
          return
        }

        const stringData = typeof event.data === "string" ? event.data : ""
        if (stringData && stringData.charCodeAt(0) === 0) {
          const json = stringData.slice(1)
          try {
            const meta = JSON.parse(json) as { cursor?: unknown }
            const next = meta?.cursor
            if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
              cursor = next
            }
          } catch (err) {
            debugTerminal("invalid websocket control frame (string)", err)
          }
          return
        }

        writeIncoming(stringData)
      }
      socket.addEventListener("message", handleMessage)
      cleanups.push(() => socket.removeEventListener("message", handleMessage))

      const handleError = (error: Event) => {
        if (disposed) return
        if (once.value) return
        once.value = true
        local.onConnectError?.(error)
      }
      socket.addEventListener("error", handleError)
      cleanups.push(() => socket.removeEventListener("error", handleError))

      const handleClose = (event: CloseEvent) => {
        if (disposed) return
        // Normal closure (code 1000) means PTY process exited - server event handles cleanup
        // For other codes (network issues, server restart), trigger error handler
        if (event.code !== 1000) {
          if (once.value) return
          once.value = true
          local.onConnectError?.(new Error(`WebSocket closed abnormally: ${event.code}`))
        }
      }
      socket.addEventListener("close", handleClose)
      cleanups.push(() => socket.removeEventListener("close", handleClose))
    }

    void run().catch((err) => {
      if (disposed) return
      showToast({
        variant: "error",
        title: language.t("terminal.connectionLost.title"),
        description: err instanceof Error ? err.message : language.t("terminal.connectionLost.description"),
      })
      local.onConnectError?.(err)
    })
  })

  onCleanup(() => {
    disposed = true
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame)
    if (sizeTimer !== undefined) clearTimeout(sizeTimer)
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.close()

    const finalize = () => {
      persistTerminal({ term, addon: serializeAddon, cursor, id, onCleanup: props.onCleanup })
      cleanup()
      resetTerminalContainer(container)
    }

    if (!output) {
      finalize()
      return
    }

    output.flush(finalize)
  })

  return (
    <div
      ref={container}
      data-component="terminal"
      data-prevent-autofocus
      tabIndex={-1}
      style={{
        "background-color": terminalColors().background,
      }}
      classList={{
        ...(local.classList ?? {}),
        "select-text": true,
        "size-full px-6 py-3 font-mono relative overflow-hidden": true,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    />
  )
}
