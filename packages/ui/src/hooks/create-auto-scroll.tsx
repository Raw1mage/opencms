import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { isScrollDebugEnabled, pushScrollDebug, type ScrollDebugEntry } from "./scroll-debug"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  overflowAnchor?: "none" | "auto" | "dynamic"
  bottomThreshold?: number
  debugName?: string
  followOnResize?: boolean
}

export function createAutoScroll(options: AutoScrollOptions) {
  let scroll: HTMLElement | undefined
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let cleanup: (() => void) | undefined
  let auto: { top: number; time: number } | undefined

  const threshold = () => options.bottomThreshold ?? 10
  const followThreshold = () => Math.max(4, threshold())
  const debugEnabled = () => isScrollDebugEnabled()

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  const active = () => options.working() || settling

  const distanceFromBottom = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const debug = (event: string, extra: Record<string, unknown> = {}) => {
    if (!debugEnabled()) return
    const el = scroll
    const entry: ScrollDebugEntry = {
      time: Date.now(),
      scope: options.debugName ?? "auto-scroll",
      event,
      userScrolled: store.userScrolled,
      active: active(),
      settling,
      scrollTop: el?.scrollTop,
      scrollHeight: el?.scrollHeight,
      clientHeight: el?.clientHeight,
      distanceFromBottom: el ? distanceFromBottom(el) : undefined,
      ...extra,
    }
    pushScrollDebug(entry)
    console.debug("[scroll-debug]", entry)
  }

  const canScroll = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight > 1
  }

  // Browsers can dispatch scroll events asynchronously. If new content arrives
  // between us calling `scrollTo()` and the subsequent `scroll` event firing,
  // the handler can see a non-zero `distanceFromBottom` and incorrectly assume
  // the user scrolled.
  const markAuto = (el: HTMLElement) => {
    auto = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
    }

    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      auto = undefined
      autoTimer = undefined
    }, 250)
  }

  const isAuto = (el: HTMLElement) => {
    const a = auto
    if (!a) return false

    if (Date.now() - a.time > 250) {
      auto = undefined
      return false
    }

    return Math.abs(el.scrollTop - a.top) < 2
  }

  const scrollToBottomNow = (behavior: ScrollBehavior) => {
    const el = scroll
    if (!el) return
    debug("scroll-apply", { behavior })
    markAuto(el)
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior })
      return
    }

    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    el.scrollTop = el.scrollHeight
  }

  const scrollToBottom = (force: boolean) => {
    if (!force && !active()) return
    const el = scroll
    if (!el) return

    debug("scroll-request", { force })

    if (!force && store.userScrolled) {
      debug("scroll-blocked-user", { force })
      return
    }
    if (force && store.userScrolled) setStore("userScrolled", false)

    const distance = distanceFromBottom(el)
    if (distance < 2) {
      debug("scroll-skip-near-bottom", { force })
      return
    }

    // For auto-following content we prefer immediate updates to avoid
    // visible "catch up" animations while content is still settling.
    scrollToBottomNow("auto")
  }

  const stop = () => {
    const el = scroll
    if (!el) return
    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }
    if (store.userScrolled) return

    setStore("userScrolled", true)
    debug("user-stop")
    options.onUserInteracted?.()
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY >= 0) return
    // If the user is scrolling within a nested scrollable region (tool output,
    // code block, etc), don't treat it as leaving the "follow bottom" mode.
    // Those regions opt in via `data-scrollable`.
    const el = scroll
    const target = e.target instanceof Element ? e.target : undefined
    const nested = target?.closest("[data-scrollable]")
    if (el && nested && nested !== el) return
    stop()
  }

  const handleScroll = () => {
    const el = scroll
    if (!el) return

    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    if (distanceFromBottom(el) < threshold()) {
      if (store.userScrolled) setStore("userScrolled", false)
      debug("handle-scroll-bottom-zone")
      return
    }

    // Ignore scroll events triggered by our own scrollToBottom calls.
    if (!store.userScrolled && isAuto(el)) {
      debug("handle-scroll-auto")
      scrollToBottom(false)
      return
    }

    debug("handle-scroll-user")
    stop()
  }

  const handleInteraction = () => {
    if (!active()) return
    debug("interaction")
    stop()
  }

  const updateOverflowAnchor = (el: HTMLElement) => {
    const mode = options.overflowAnchor ?? "dynamic"

    if (mode === "none") {
      el.style.overflowAnchor = "none"
      return
    }

    if (mode === "auto") {
      el.style.overflowAnchor = "auto"
      return
    }

    el.style.overflowAnchor = store.userScrolled ? "auto" : "none"
  }

  createResizeObserver(
    () => store.contentRef,
    () => {
      const el = scroll
      if (el && !canScroll(el)) {
        if (store.userScrolled) setStore("userScrolled", false)
        debug("resize-no-scroll")
        return
      }
      if (!active()) return
      if (options.followOnResize === false) {
        debug("resize-follow-disabled")
        return
      }
      if (store.userScrolled) {
        debug("resize-blocked-user")
        return
      }
      const distance = el ? distanceFromBottom(el) : Infinity
      if (!Number.isFinite(distance) || distance > followThreshold()) {
        debug("resize-blocked-distance", { distance, followThreshold: followThreshold() })
        return
      }
      // ResizeObserver fires after layout, before paint.
      // Keep the bottom locked in the same frame to avoid visible
      // "jump up then catch up" artifacts while streaming content.
      debug("resize-follow")
      scrollToBottom(false)
    },
  )

  createEffect(
    on(options.working, (working: boolean) => {
      settling = false
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined

      if (working) {
        debug("working-start")
        if (!store.userScrolled) scrollToBottom(true)
        return
      }

      debug("working-stop")
      settling = true
      settleTimer = setTimeout(() => {
        settling = false
      }, 300)
    }),
  )

  createEffect(() => {
    // Track `userScrolled` even before `scrollRef` is attached, so we can
    // update overflow anchoring once the element exists.
    store.userScrolled
    const el = scroll
    if (!el) return
    updateOverflowAnchor(el)
  })

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (autoTimer) clearTimeout(autoTimer)
    if (cleanup) cleanup()
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => {
      if (cleanup) {
        cleanup()
        cleanup = undefined
      }

      scroll = el

      if (!el) return

      updateOverflowAnchor(el)
      debug("attach")
      el.addEventListener("wheel", handleWheel, { passive: true })

      cleanup = () => {
        el.removeEventListener("wheel", handleWheel)
      }
    },
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    handleInteraction,
    pause: stop,
    resume: () => {
      if (store.userScrolled) setStore("userScrolled", false)
      debug("resume")
      scrollToBottom(true)
    },
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => scrollToBottom(true),
    userScrolled: () => store.userScrolled,
  }
}
