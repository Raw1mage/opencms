import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { UserMessage } from "@opencode-ai/sdk/v2"

export const anchor = (id: string) => `message-${id}`

export const messageIdFromHash = (hash: string) => {
  const value = hash.startsWith("#") ? hash.slice(1) : hash
  const match = value.match(/^message-(.+)$/)
  if (!match) return
  return match[1]
}

type NewInput = {
  sessionKey: () => string
  sessionID: () => string | undefined
  messagesReady: () => boolean
  working: () => boolean
  visibleUserMessages: () => UserMessage[]
  turnStart: () => number
  currentMessageId: () => string | undefined
  pendingMessage: () => string | undefined
  setPendingMessage: (value: string | undefined) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  setTurnStart: (value: number) => void
  scheduleTurnBackfill: () => void
  autoScroll: { pause: (force?: boolean) => void; scrollToBottom: () => void }
  scroller: () => HTMLDivElement | undefined
  anchor: (id: string) => string
  scheduleScrollState: (el: HTMLDivElement) => void
  consumePendingMessage: (key: string) => string | undefined
  userScrolled?: () => boolean
}

type LegacyInput = {
  scroller: () => HTMLDivElement | undefined
  messages: () => UserMessage[]
  messagesReady: () => boolean
  activeMessageId: () => string | undefined
  onActiveChange: (id: string | undefined) => void
  onPauseAutoScroll: () => void
  onScrollToBottom: () => void
  turnStart: () => number
  onBackfill: (index: number) => void
}

export const scrollToElement = (root: HTMLDivElement | undefined, el: HTMLElement, behavior: ScrollBehavior) => {
  if (!root) return false
  const a = el.getBoundingClientRect()
  const b = root.getBoundingClientRect()
  const sticky = root.querySelector("[data-session-title]")
  const inset = sticky instanceof HTMLElement ? sticky.offsetHeight : 0
  const top = Math.max(0, a.top - b.top + root.scrollTop - inset)
  root.scrollTo({ top, behavior })
  return true
}

export const useSessionHashScroll = (rawInput: NewInput | LegacyInput) => {
  const input: NewInput =
    "messages" in rawInput
      ? {
          sessionKey: () => "legacy",
          sessionID: () => "legacy",
          messagesReady: rawInput.messagesReady,
          working: () => false,
          visibleUserMessages: rawInput.messages,
          turnStart: rawInput.turnStart,
          currentMessageId: rawInput.activeMessageId,
          pendingMessage: () => undefined,
          setPendingMessage: () => {},
          setActiveMessage: (message) => rawInput.onActiveChange(message?.id),
          setTurnStart: rawInput.onBackfill,
          scheduleTurnBackfill: () => {},
          autoScroll: {
            pause: rawInput.onPauseAutoScroll,
            scrollToBottom: rawInput.onScrollToBottom,
          },
          scroller: rawInput.scroller,
          anchor,
          scheduleScrollState: () => {},
          consumePendingMessage: () => undefined,
          userScrolled: () => false,
        }
      : rawInput

  const visibleUserMessages = createMemo(() => input.visibleUserMessages())
  const messageById = createMemo(() => new Map(visibleUserMessages().map((m) => [m.id, m])))
  const messageIndex = createMemo(() => new Map(visibleUserMessages().map((m, i) => [m.id, i])))
  const [initialAppliedForSession, setInitialAppliedForSession] = createSignal(false)

  const clearMessageHash = () => {
    if (!window.location.hash) return
    window.history.replaceState(null, "", window.location.href.replace(/#.*$/, ""))
  }

  const updateHash = (id: string) => {
    window.history.replaceState(null, "", `#${input.anchor(id)}`)
  }

  // Shadowing the exported scrollToElement with the one from the commit that is bound to input.scroller
  const scrollToElement = (el: HTMLElement, behavior: ScrollBehavior) => {
    const root = input.scroller()
    if (!root) return false

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    const top = a.top - b.top + root.scrollTop
    root.scrollTo({ top, behavior })
    return true
  }

  const scrollToMessage = (message: UserMessage, behavior: ScrollBehavior = "smooth") => {
    if (input.currentMessageId() !== message.id) input.setActiveMessage(message)

    const index = messageIndex().get(message.id) ?? -1
    if (index !== -1 && index < input.turnStart()) {
      input.setTurnStart(index)
      input.scheduleTurnBackfill()

      requestAnimationFrame(() => {
        const el = document.getElementById(input.anchor(message.id))
        if (!el) {
          requestAnimationFrame(() => {
            const next = document.getElementById(input.anchor(message.id))
            if (!next) return
            scrollToElement(next, behavior)
          })
          return
        }
        scrollToElement(el, behavior)
      })

      updateHash(message.id)
      return
    }

    const el = document.getElementById(input.anchor(message.id))
    if (!el) {
      updateHash(message.id)
      requestAnimationFrame(() => {
        const next = document.getElementById(input.anchor(message.id))
        if (!next) return
        if (!scrollToElement(next, behavior)) return
      })
      return
    }
    if (scrollToElement(el, behavior)) {
      updateHash(message.id)
      return
    }

    requestAnimationFrame(() => {
      const next = document.getElementById(input.anchor(message.id))
      if (!next) return
      if (!scrollToElement(next, behavior)) return
    })
    updateHash(message.id)
  }

  const applyHash = (behavior: ScrollBehavior) => {
    const hash = window.location.hash.slice(1)
    if (!hash) {
      if (input.userScrolled?.()) return
      input.autoScroll.scrollToBottom()
      const el = input.scroller()
      if (el) input.scheduleScrollState(el)
      return
    }

    const messageId = messageIdFromHash(hash)
    if (messageId) {
      input.autoScroll.pause(true)
      const msg = messageById().get(messageId)
      if (msg) {
        scrollToMessage(msg, behavior)
        return
      }
      return
    }

    const target = document.getElementById(hash)
    if (target) {
      input.autoScroll.pause(true)
      scrollToElement(target, behavior)
      return
    }

    input.autoScroll.scrollToBottom()
    const el = input.scroller()
    if (el) input.scheduleScrollState(el)
  }

  createEffect(
    on(input.sessionKey, (key) => {
      setInitialAppliedForSession(false)
      if (!input.sessionID()) return
      const messageID = input.consumePendingMessage(key)
      if (!messageID) return
      input.setPendingMessage(messageID)
    }),
  )

  createEffect(() => {
    if (!input.sessionID() || !input.messagesReady()) return
    if (!initialAppliedForSession()) {
      setInitialAppliedForSession(true)
      requestAnimationFrame(() => {
        if (window.location.hash) {
          applyHash("auto")
          return
        }
        if (input.userScrolled?.()) return
        input.setActiveMessage(undefined)
        input.autoScroll.scrollToBottom()
        const el = input.scroller()
        if (el) input.scheduleScrollState(el)
        clearMessageHash()
      })
      return
    }

    // Skip hash-based scroll during active streaming — the reactive
    // dependencies (messagesReady, etc.) re-trigger this effect as new
    // content arrives, and the resulting rAF scroll fights follow-bottom.
    if (input.working()) return
    if (input.userScrolled?.()) return

    requestAnimationFrame(() => applyHash("auto"))
  })

  createEffect(() => {
    if (!input.sessionID() || !input.messagesReady()) return

    visibleUserMessages()
    input.turnStart()

    const pending = input.pendingMessage()
    const targetId = pending
    if (!targetId) return
    if (input.currentMessageId() === targetId) return

    // Skip pending-message scroll during active streaming.
    if (input.working()) return

    const msg = messageById().get(targetId)
    if (!msg) return

    if (input.pendingMessage() === targetId) input.setPendingMessage(undefined)
    input.autoScroll.pause(true)
    requestAnimationFrame(() => scrollToMessage(msg, "auto"))
  })

  createEffect(() => {
    if (!input.sessionID() || !input.messagesReady()) return
    const handler = () => {
      requestAnimationFrame(() => applyHash("auto"))
    }
    window.addEventListener("hashchange", handler)
    onCleanup(() => window.removeEventListener("hashchange", handler))
  })

  return {
    clearMessageHash,
    scrollToMessage,
    applyHash,
  }
}
