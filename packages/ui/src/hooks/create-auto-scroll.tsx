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
  resumeOnly?: boolean
}

type ScrollMode = "follow-bottom" | "free-reading"

export function createAutoScroll(options: AutoScrollOptions) {
  let scroll: HTMLElement | undefined
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let deferredFollowFrame: number | undefined
  let cleanup: (() => void) | undefined
  let auto: { top: number; time: number } | undefined

  const threshold = () => options.bottomThreshold ?? 10
  const followThreshold = () => Math.max(4, threshold())
  const debugEnabled = () => isScrollDebugEnabled()

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    mode: "follow-bottom" as ScrollMode,
  })

  const userScrolled = () => store.mode === "free-reading"

  const setMode = (mode: ScrollMode, reason: string, extra: Record<string, unknown> = {}) => {
    if (store.mode === mode) return
    setStore("mode", mode)
    debug("mode-change", { mode, reason, ...extra })
  }

  const active = () => options.working() || settling

  const distanceFromBottom = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const metrics = (el?: HTMLElement) => {
    if (!el) return {}
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distanceFromBottom: distanceFromBottom(el),
      maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
    }
  }

  const debug = (event: string, extra: Record<string, unknown> = {}) => {
    if (!debugEnabled()) return
    const el = scroll
    const entry: ScrollDebugEntry = {
      time: Date.now(),
      scope: options.debugName ?? "auto-scroll",
      event,
      userScrolled: userScrolled(),
      mode: store.mode,
      active: active(),
      settling,
      ...metrics(el),
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
    debug("scroll-apply", { behavior, phase: "before", ...metrics(el) })
    markAuto(el)
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior })
      debug("scroll-apply", { behavior, phase: "after-scrollTo", ...metrics(el) })
      return
    }

    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    el.scrollTop = el.scrollHeight
    debug("scroll-apply", { behavior, phase: "after-assignment", ...metrics(el) })
  }

  const scheduleDeferredFollow = (reason: string) => {
    if (deferredFollowFrame !== undefined) cancelAnimationFrame(deferredFollowFrame)
    deferredFollowFrame = requestAnimationFrame(() => {
      deferredFollowFrame = undefined
      const el = scroll
      if (!el) return
      if (userScrolled()) {
        debug("deferred-follow-blocked-user", { reason })
        return
      }
      const distance = distanceFromBottom(el)
      if (distance <= 1) {
        debug("deferred-follow-skip", { reason, distance })
        return
      }
      debug("deferred-follow", { reason, distance })
      scrollToBottomNow("auto")
    })
  }

  const scrollToBottom = (force: boolean) => {
    if (!force && !active()) return
    const el = scroll
    if (!el) return

    debug("scroll-request", { force })

    if (!force && userScrolled()) {
      debug("scroll-blocked-user", { force })
      return
    }
    if (force && userScrolled()) setMode("follow-bottom", "forced-scroll")

    const distance = distanceFromBottom(el)
    debug("bottom-formula", {
      reason: "scroll-request",
      threshold: threshold(),
      followThreshold: followThreshold(),
      distance,
    })
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
      if (userScrolled()) setMode("follow-bottom", "no-overflow")
      return
    }
    if (userScrolled()) return

    setMode("free-reading", "user-stop")
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
      if (userScrolled()) setMode("follow-bottom", "no-overflow")
      return
    }

    if (distanceFromBottom(el) < threshold()) {
      if (userScrolled() && !options.resumeOnly) setMode("follow-bottom", "bottom-zone")
      debug("handle-scroll-bottom-zone")
      return
    }

    // Ignore scroll events triggered by our own scrollToBottom calls.
    if (!userScrolled() && isAuto(el)) {
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

    el.style.overflowAnchor = userScrolled() ? "auto" : "none"
  }

  createResizeObserver(
    () => store.contentRef,
    () => {
      const el = scroll
      if (el && !canScroll(el)) {
        if (userScrolled()) setMode("follow-bottom", "resize-no-scroll")
        debug("resize-no-scroll")
        return
      }
      if (!active()) return
      if (options.followOnResize === false) {
        debug("resize-follow-disabled")
        return
      }
      if (userScrolled()) {
        debug("resize-blocked-user")
        return
      }
      const distance = el ? distanceFromBottom(el) : Infinity
      debug("bottom-formula", {
        reason: "resize-observer",
        threshold: threshold(),
        followThreshold: followThreshold(),
        distance,
        resumeOnly: options.resumeOnly === true,
      })
      if (!options.resumeOnly && (!Number.isFinite(distance) || distance > followThreshold())) {
        debug("resize-blocked-distance", { distance, followThreshold: followThreshold() })
        return
      }
      // ResizeObserver fires after layout, before paint.
      // Keep the bottom locked in the same frame to avoid visible
      // "jump up then catch up" artifacts while streaming content.
      debug("resize-follow", { distance, followThreshold: followThreshold(), resumeOnly: options.resumeOnly === true })
      scrollToBottom(false)
      scheduleDeferredFollow("resize-follow")
    },
  )

  createEffect(
    on(options.working, (working: boolean) => {
      settling = false
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined

      if (working) {
        debug("working-start")
        if (!userScrolled()) scrollToBottom(true)
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
    // Track scroll mode even before `scrollRef` is attached, so we can
    // update overflow anchoring once the element exists.
    store.mode
    const el = scroll
    if (!el) return
    updateOverflowAnchor(el)
  })

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (autoTimer) clearTimeout(autoTimer)
    if (deferredFollowFrame !== undefined) cancelAnimationFrame(deferredFollowFrame)
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
      if (userScrolled()) setMode("follow-bottom", "explicit-resume")
      debug("resume")
      scrollToBottom(true)
    },
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => scrollToBottom(true),
    userScrolled,
    mode: () => store.mode,
  }
}
