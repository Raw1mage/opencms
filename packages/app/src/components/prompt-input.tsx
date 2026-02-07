import { useFilteredList } from "@opencode-ai/ui/hooks"
import {
  createEffect,
  on,
  Component,
  Show,
  onMount,
  onCleanup,
  Switch,
  Match,
  createMemo,
  createSignal,
} from "solid-js"
import { createStore } from "solid-js/store"
import { createFocusSignal } from "@solid-primitives/active-element"
import { useLocal } from "@/context/local"
import { useFile } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useNavigate, useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useProviders } from "@/hooks/use-providers"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { SessionContextUsage } from "@/components/session-context-usage"
import { usePermission } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { ContextItems } from "./prompt-input/context-items"
import { ImageAttachments } from "./prompt-input/image-attachments"
import { promptPlaceholder } from "./prompt-input/placeholder"
import { createPromptAttachments, ACCEPTED_FILE_TYPES } from "./prompt-input/attachments"
import { createPromptSubmit } from "./prompt-input/submit"
import { PromptPopover, type AtOption, type SlashCommand } from "./prompt-input/slash-popover"
import {
  promptLength,
  prependHistoryEntry,
  navigatePromptHistory,
} from "./prompt-input/history"
import {
  createTextFragment,
  getCursorPosition,
  setCursorPosition,
  setRangeEdge,
  createPill,
  isNormalizedEditor,
  parseFromDOM,
  renderEditor,
} from "./prompt-input/editor-dom"

interface PromptInputProps {
  class?: string
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  onSubmit?: () => void
}

const EXAMPLES = [
  "prompt.example.1",
  "prompt.example.2",
  "prompt.example.3",
  "prompt.example.4",
  "prompt.example.5",
  "prompt.example.6",
  "prompt.example.7",
  "prompt.example.8",
  "prompt.example.9",
  "prompt.example.10",
  "prompt.example.11",
  "prompt.example.12",
  "prompt.example.13",
  "prompt.example.14",
  "prompt.example.15",
  "prompt.example.16",
  "prompt.example.17",
  "prompt.example.18",
  "prompt.example.19",
  "prompt.example.20",
  "prompt.example.21",
  "prompt.example.22",
  "prompt.example.23",
  "prompt.example.24",
  "prompt.example.25",
] as const

export const PromptInput: Component<PromptInputProps> = (props) => {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const commentCount = createMemo(() => prompt.context.items().filter((item) => !!item.comment?.trim()).length)
  const layout = useLayout()
  const comments = useComments()
  const params = useParams()
  const dialog = useDialog()
  const providers = useProviders()
  const command = useCommand()
  const permission = usePermission()
  const language = useLanguage()
  let editorRef!: HTMLDivElement
  let fileInputRef!: HTMLInputElement
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

  const mirror = { input: false }

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const rect = range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - padding) {
      container.scrollTop = bottom - container.clientHeight + padding
    }
  }

  const queueScroll = () => {
    requestAnimationFrame(scrollCursorIntoView)
  }

  const recent = createMemo(() => {
    const sessionKey = `${params.dir}${params.id ? "/" + params.id : ""}`
    const tabs = layout.tabs(sessionKey)
    const all = tabs.all()
    const active = tabs.active()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const status = createMemo(
    () =>
      sync.data.session_status[params.id ?? ""] ?? {
        type: "idle",
      },
  )
  const working = createMemo(() => status()?.type !== "idle")

  const [store, setStore] = createStore<{
    popover: "at" | "slash" | null
    historyIndex: number
    savedPrompt: Prompt | null
    placeholder: number
    mode: "normal" | "shell"
    applyingHistory: boolean
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null,
    placeholder: Math.floor(Math.random() * EXAMPLES.length),
    mode: "normal",
    applyingHistory: false,
  })

  const [history, setHistory] = persisted(
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )
  const [shellHistory, setShellHistory] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )

  const {
    imageAttachments,
    addImageAttachment,
    removeImageAttachment,
    handlePaste: attachmentHandlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    dragging,
  } = createPromptAttachments()

  const addToHistory = (p: Prompt, mode: "normal" | "shell") => {
    if (mode === "shell") {
      const next = prependHistoryEntry(shellHistory.entries, p)
      if (next !== shellHistory.entries) setShellHistory("entries", next)
    } else {
      const next = prependHistoryEntry(history.entries, p)
      if (next !== history.entries) setHistory("entries", next)
    }
  }

  const { handleSubmit, abort } = createPromptSubmit({
    info,
    imageAttachments,
    commentCount,
    mode: () => store.mode,
    working,
    editor: () => editorRef,
    queueScroll,
    promptLength,
    addToHistory,
    setMode: (m) => setStore("mode", m),
    setPopover: (p) => setStore("popover", p),
    newSessionWorktree: props.newSessionWorktree,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    onSubmit: props.onSubmit,
  })

  const applyHistoryPrompt = (p: Prompt, position: "start" | "end") => {
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const isFocused = createFocusSignal(() => editorRef)

  createEffect(() => {
    params.id
    if (params.id) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % EXAMPLES.length)
    }, 6500)
    onCleanup(() => clearInterval(interval))
  })

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  const handlePaste = async (event: ClipboardEvent) => {
    if (!isFocused()) return
    attachmentHandlePaste(event)
    if (event.defaultPrevented) return

    const plainText = event.clipboardData?.getData("text/plain") ?? ""
    if (!plainText) return
    addPart({ type: "text", content: plainText, start: 0, end: 0 })
    event.preventDefault()
  }

  onMount(() => {
    document.addEventListener("dragover", handleGlobalDragOver)
    document.addEventListener("dragleave", handleGlobalDragLeave)
    document.addEventListener("drop", handleGlobalDrop)
  })
  onCleanup(() => {
    document.removeEventListener("dragover", handleGlobalDragOver)
    document.removeEventListener("dragleave", handleGlobalDragLeave)
    document.removeEventListener("drop", handleGlobalDrop)
  })

  const handleGlobalDragOver = (event: DragEvent) => {
    if (dialog.active) return
    handleDragOver(event)
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (dialog.active) return
    // relatedTarget is null when leaving the document window
    if (!event.relatedTarget) {
      handleDragLeave(event)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (dialog.active) return
    handleDrop(event)
  }

  createEffect(() => {
    if (!isFocused()) setStore("popover", null)
  })

  // Safety: reset composing state on focus change to prevent stuck state
  // This handles edge cases where compositionend event may not fire
  createEffect(() => {
    if (!isFocused()) setComposing(false)
  })

  const agentList = createMemo(() =>
    sync.data.agent
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AtOption => ({ type: "agent", name: agent.name, display: agent.name })),
  )

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
    } else {
      addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
    }
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    return x.type === "agent" ? `agent:${x.name}` : `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const agents = agentList()
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...agents, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    groupBy: (item) => {
      if (item.type === "agent") return "agent"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "agent") return 0
        if (category === "recent") return 1
        return 2
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
  })

  const source = (value: string | undefined): SlashCommand["source"] =>
    value === "command" || value === "mcp" || value === "skill" ? value : undefined

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .map((opt) => ({
        id: opt.id,
        trigger: opt.slash!,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      }))

    const custom = sync.data.command.map((cmd) => ({
      id: `custom.${cmd.name}`,
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      type: "custom" as const,
      source: source(cmd.source),
    }))

    const skills = sync.data.skill.map((skill) => ({
      id: `skill.${skill.name}`,
      trigger: `skill:${skill.name}`,
      title: skill.name,
      description: skill.description,
      type: "skill" as const,
    }))

    return [...skills, ...custom, ...builtin]
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    setStore("popover", null)

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      editorRef.innerHTML = ""
      editorRef.textContent = text
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      requestAnimationFrame(() => {
        editorRef.focus()
        const range = document.createRange()
        const sel = window.getSelection()
        range.selectNodeContents(editorRef)
        range.collapse(false)
        sel?.removeAllRanges()
        sel?.addRange(range)
      })
      return
    }

    if (cmd.type === "skill") {
      // Extract skill name from the id (skill.{name})
      const skillName = cmd.id.replace("skill.", "")
      const text = `Load the "${skillName}" skill and follow its instructions.`
      editorRef.innerHTML = ""
      editorRef.textContent = text
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      requestAnimationFrame(() => {
        editorRef.focus()
        const range = document.createRange()
        const sel = window.getSelection()
        range.selectNodeContents(editorRef)
        range.collapse(false)
        sel?.removeAllRanges()
        sel?.addRange(range)
      })
      return
    }

    editorRef.innerHTML = ""
    prompt.set([{ type: "text", content: "", start: 0, end: 0 }], 0)
    command.trigger(cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
    refetch: slashRefetch,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title", "description"],
    onSelect: handleSlashSelect,
  })

  createEffect(
    on(
      () => sync.data.command,
      () => slashRefetch(),
      { defer: true },
    ),
  )

  // Auto-scroll active command into view when navigating with keyboard
  createEffect(() => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })

  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  createEffect(
    on(
      () => prompt.current(),
      (currentParts) => {
        const inputParts = currentParts.filter((part) => part.type !== "image") as Prompt

        if (mirror.input) {
          mirror.input = false
          if (isNormalizedEditor(editorRef)) return

          const selection = window.getSelection()
          let cursorPosition: number | null = null
          if (selection && selection.rangeCount > 0 && editorRef.contains(selection.anchorNode)) {
            cursorPosition = getCursorPosition(editorRef)
          }

          renderEditor(editorRef, inputParts)

          if (cursorPosition !== null) {
            setCursorPosition(editorRef, cursorPosition)
          }
          return
        }

        const domParts = parseFromDOM(editorRef)
        if (isNormalizedEditor(editorRef) && isPromptEqual(inputParts, domParts)) return

        const selection = window.getSelection()
        let cursorPosition: number | null = null
        if (selection && selection.rangeCount > 0 && editorRef.contains(selection.anchorNode)) {
          cursorPosition = getCursorPosition(editorRef)
        }

        renderEditor(editorRef, inputParts)

        if (cursorPosition !== null) {
          setCursorPosition(editorRef, cursorPosition)
        }
      },
    ),
  )

  const handleInput = () => {
    const rawParts = parseFromDOM(editorRef)
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText = rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const trimmed = rawText.replace(/\u200B/g, "").trim()
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const shouldReset = trimmed.length === 0 && !hasNonText && images.length === 0

    if (shouldReset) {
      setStore("popover", null)
      if (store.historyIndex >= 0 && !store.applyingHistory) {
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
      }
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        setStore("popover", null)
      }
    } else {
      setStore("popover", null)
    }

    if (store.historyIndex >= 0 && !store.applyingHistory) {
      setStore("historyIndex", -1)
      setStore("savedPrompt", null)
    }

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    queueScroll()
  }

  const addPart = (part: ContentPart) => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const cursorPosition = getCursorPosition(editorRef)
    const currentPrompt = prompt.current()
    const rawText = currentPrompt.map((p) => ("content" in p ? p.content : "")).join("")
    const textBeforeCursor = rawText.substring(0, cursorPosition)
    const atMatch = textBeforeCursor.match(/@(\S*)$/)

    if (part.type === "file" || part.type === "agent") {
      const pill = createPill(part)
      const gap = document.createTextNode(" ")
      const range = selection.getRangeAt(0)

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(editorRef, range, "start", start)
        setRangeEdge(editorRef, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    } else if (part.type === "text") {
      const range = selection.getRangeAt(0)
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          range.setStartAfter(last)
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    setStore("popover", null)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }
    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Escape") {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        setStore("popover", null)
        event.preventDefault()
        return
      }
      if (working()) {
        abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textLength = promptLength(prompt.current())
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const isEmpty = textContent.trim() === "" || textLength <= 1
      const hasNewlines = textContent.includes("\n")
      const inHistory = store.historyIndex >= 0
      const atStart = cursorPosition <= (isEmpty ? 1 : 0)
      const atEnd = cursorPosition >= (isEmpty ? textLength - 1 : textLength)
      const allowUp = isEmpty || atStart || (!hasNewlines && !inHistory) || (inHistory && atEnd)
      const allowDown = isEmpty || atEnd || (!hasNewlines && !inHistory) || (inHistory && atStart)

      const result = navigatePromptHistory({
        direction: event.key === "ArrowUp" ? "up" : "down",
        entries: store.mode === "shell" ? shellHistory.entries : history.entries,
        historyIndex: store.historyIndex,
        currentPrompt: prompt.current(),
        savedPrompt: store.savedPrompt,
      })

      if (result.handled) {
        if (event.key === "ArrowUp" && !allowUp) return
        if (event.key === "ArrowDown" && !allowDown) return

        if (result.savedPrompt !== undefined) setStore("savedPrompt", result.savedPrompt)
        setStore("historyIndex", result.historyIndex)
        applyHistoryPrompt(result.prompt, result.cursor)
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      handleSubmit(event)
    }
    if (event.key === "Escape") {
      if (store.popover) {
        setStore("popover", null)
      } else if (working()) {
        abort()
      }
    }
  }

  return (
    <div class="relative size-full _max-h-[320px] flex flex-col gap-3">
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        atFlat={atFlat()}
        atActive={atActive()}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        slashFlat={slashFlat()}
        slashActive={slashActive()}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={(id) => command.keybind(id)}
        t={language.t}
      />
      <form
        onSubmit={handleSubmit}
        classList={{
          "group/prompt-input": true,
          "bg-surface-raised-stronger-non-alpha shadow-xs-border relative": true,
          "rounded-[14px] overflow-clip focus-within:shadow-xs-border": true,
          "border-icon-info-active border-dashed": dragging(),
        }}
      >
        <Show when={dragging()}>
          <div class="absolute inset-0 z-10 flex items-center justify-center bg-surface-raised-stronger-non-alpha/90 pointer-events-none">
            <div class="flex flex-col items-center gap-2 text-text-weak">
              <Icon name="photo" class="size-8" />
              <span class="text-14-regular">{language.t("prompt.dropzone.label")}</span>
            </div>
          </div>
        </Show>
        <ContextItems />
        <ImageAttachments attachments={imageAttachments()} onRemove={removeImageAttachment} />
        <div class="relative max-h-[240px] overflow-y-auto" ref={(el) => (scrollRef = el)}>
          <div
            data-component="prompt-input"
            ref={(el) => {
              editorRef = el
              props.ref?.(el)
            }}
            role="textbox"
            aria-multiline="true"
            aria-label={promptPlaceholder({
              mode: store.mode,
              commentCount: commentCount(),
              example: language.t(EXAMPLES[store.placeholder]),
              t: language.t,
            })}
            contenteditable="true"
            onInput={handleInput}
            onPaste={handlePaste}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={handleKeyDown}
            classList={{
              "select-text": true,
              "w-full p-3 pr-12 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap": true,
              "[&_[data-type=file]]:text-syntax-property": true,
              "[&_[data-type=agent]]:text-syntax-type": true,
              "font-mono!": store.mode === "shell",
            }}
          />
          <Show when={!prompt.dirty()}>
            <div class="absolute top-0 inset-x-0 p-3 pr-12 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate">
              {promptPlaceholder({
                mode: store.mode,
                commentCount: commentCount(),
                example: language.t(EXAMPLES[store.placeholder]),
                t: language.t,
              })}
            </div>
          </Show>
        </div>
        <div class="relative p-3 flex items-center justify-between">
          <div class="flex items-center justify-start gap-0.5">
            <Switch>
              <Match when={store.mode === "shell"}>
                <div class="flex items-center gap-2 px-2 h-6">
                  <Icon name="console" size="small" class="text-icon-primary" />
                  <span class="text-12-regular text-text-primary">{language.t("prompt.mode.shell")}</span>
                  <span class="text-12-regular text-text-weak">{language.t("prompt.mode.shell.exit")}</span>
                </div>
              </Match>
              <Match when={store.mode === "normal"}>
                <TooltipKeybind
                  placement="top"
                  title={language.t("command.agent.cycle")}
                  keybind={command.keybind("agent.cycle")}
                >
                  <Select
                    options={local.agent.list().map((agent) => agent.name)}
                    current={local.agent.current()?.name ?? ""}
                    onSelect={local.agent.set}
                    class="capitalize"
                    variant="ghost"
                  />
                </TooltipKeybind>
                <TooltipKeybind
                  placement="top"
                  title={language.t("command.model.choose")}
                  keybind={command.keybind("model.choose")}
                >
                  <Button variant="ghost" onClick={() => command.trigger("model.choose")}>
                    <Icon name="models" size="small" class="text-accent-primary" />
                    <span class="text-text-secondary">{local.model.current()?.name ?? "Auto"}</span>
                  </Button>
                </TooltipKeybind>
                <Show when={permission.permissionsEnabled() && params.id}>
                  <TooltipKeybind
                    placement="top"
                    title={language.t("command.permissions.autoaccept.enable")}
                    keybind={command.keybind("permissions.autoaccept")}
                  >
                    <Button
                      variant="ghost"
                      onClick={() => permission.toggleAutoAccept(params.id!, sdk.directory)}
                      classList={{
                        "_hidden group-hover/prompt-input:flex size-6 items-center justify-center": true,
                        "text-text-base": !permission.isAutoAccepting(params.id!, sdk.directory),
                        "hover:bg-surface-success-base": permission.isAutoAccepting(params.id!, sdk.directory),
                      }}
                      aria-label={
                        permission.isAutoAccepting(params.id!, sdk.directory)
                          ? language.t("command.permissions.autoaccept.disable")
                          : language.t("command.permissions.autoaccept.enable")
                      }
                      aria-pressed={permission.isAutoAccepting(params.id!, sdk.directory)}
                    >
                      <Icon
                        name="chevron-double-right"
                        size="small"
                        classList={{ "text-icon-success-base": permission.isAutoAccepting(params.id!, sdk.directory) }}
                      />
                    </Button>
                  </TooltipKeybind>
                </Show>
              </Match>
            </Switch>
          </div>
          <div class="flex items-center gap-3 absolute right-3 bottom-3">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES.join(",")}
              class="hidden"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0]
                if (file) addImageAttachment(file)
                e.currentTarget.value = ""
              }}
            />
            <div class="flex items-center gap-2">
              <SessionContextUsage />
              <Show when={store.mode === "normal"}>
                <Tooltip placement="top" value={language.t("prompt.action.attachFile")}>
                  <Button
                    type="button"
                    variant="ghost"
                    class="size-6"
                    onClick={() => fileInputRef.click()}
                    aria-label={language.t("prompt.action.attachFile")}
                  >
                    <Icon name="photo" class="size-4.5" />
                  </Button>
                </Tooltip>
              </Show>
            </div>
            <Tooltip
              placement="top"
              inactive={!prompt.dirty() && !working()}
              value={
                <Switch>
                  <Match when={working()}>
                    <div class="flex items-center gap-2">
                      <span>{language.t("prompt.action.stop")}</span>
                      <span class="text-icon-base text-12-medium text-[10px]!">{language.t("common.key.esc")}</span>
                    </div>
                  </Match>
                  <Match when={true}>
                    <div class="flex items-center gap-2">
                      <span>{language.t("prompt.action.send")}</span>
                      <Icon name="enter" size="small" class="text-icon-base" />
                    </div>
                  </Match>
                </Switch>
              }
            >
              <IconButton
                type="submit"
                disabled={!prompt.dirty() && !working()}
                icon={working() ? "stop" : "arrow-up"}
                variant="primary"
                class="h-6 w-4.5"
                aria-label={working() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
              />
            </Tooltip>
          </div>
        </div>
      </form>
    </div>
  )
}
