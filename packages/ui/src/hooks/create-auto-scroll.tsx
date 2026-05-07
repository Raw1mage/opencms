import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import {
  captureScrollIncident,
  isScrollDebugEnabled,
  isScrollIncidentCaptureEnabled,
  pushScrollDebug,
  type ScrollDebugEntry,
} from "./scroll-debug"

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
  let cleanup: (() => void) | undefined
  let auto: { top: number; time: number } | undefined
  let explicitFollow = false
  // rAF loop state (no rafId needed — uses loopActive flag)
  // Track previous scrollHeight so resize handling can detect real content
  // growth while all follow-bottom writers still converge on one exact
  // bottomScrollTop formula.
  let lastScrollHeight = 0

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
    if (mode === "free-reading") explicitFollow = false
    setStore("mode", mode)
    debug("mode-change", { mode, reason, ...extra })
    if (mode === "free-reading" && active() && isScrollIncidentCaptureEnabled()) {
      captureFreeReadingFlip(reason, extra)
    }
  }

  const captureFreeReadingFlip = (reason: string, extra: Record<string, unknown> = {}) => {
    const el = scroll
    if (!el) return
    let scrollerAnchor: string | undefined
    let firstChildAnchor: string | undefined
    let userMessageAnchor: string | undefined
    let firstChildOuterHTML: string | undefined
    let messageRects: Array<Record<string, unknown>> = []
    try {
      scrollerAnchor = getComputedStyle(el).overflowAnchor
      const content = store.contentRef
      const first = content?.firstElementChild as HTMLElement | undefined
      firstChildAnchor = first ? getComputedStyle(first).overflowAnchor : undefined
      firstChildOuterHTML = first ? first.outerHTML.slice(0, 240) : undefined
      const userMsg = content?.querySelector<HTMLElement>('[id^="message-"]')
      userMessageAnchor = userMsg ? getComputedStyle(userMsg).overflowAnchor : undefined
      const msgs = content?.querySelectorAll<HTMLElement>("[data-message-id]")
      if (msgs) {
        const tail = Array.from(msgs).slice(-4)
        const scrollerRect = el.getBoundingClientRect()
        messageRects = tail.map((m) => {
          const r = m.getBoundingClientRect()
          return {
            messageID: m.dataset.messageId,
            id: m.id || undefined,
            relativeTop: r.top - scrollerRect.top,
            relativeBottom: r.bottom - scrollerRect.top,
            height: r.height,
          }
        })
      }
    } catch {}
    void captureScrollIncident("mode-flip-free-reading", {
      reason,
      metrics: metrics(el),
      explicitFollow,
      circuitBroken,
      anchorHitTimes: [...anchorHitTimes],
      lastScrollHeight,
      mode: store.mode,
      computedAnchors: {
        scroller: scrollerAnchor,
        firstContentChild: firstChildAnchor,
        firstUserMessage: userMessageAnchor,
      },
      firstChildOuterHTML,
      messageRects,
      ...extra,
    })
  }

  const active = () => options.working() || settling

  const bottomScrollTop = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight)

  const distanceFromBottom = (el: HTMLElement) => {
    return bottomScrollTop(el) - el.scrollTop
  }

  const metrics = (el?: HTMLElement) => {
    if (!el) return {}
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distanceFromBottom: distanceFromBottom(el),
      maxScrollTop: bottomScrollTop(el),
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
      top: bottomScrollTop(el),
      time: Date.now(),
    }

    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      auto = undefined
      autoTimer = undefined
    }, 250)
  }

  const clearAuto = () => {
    auto = undefined
    if (!autoTimer) return
    clearTimeout(autoTimer)
    autoTimer = undefined
  }

  const isAuto = (_el: HTMLElement) => {
    const a = auto
    if (!a) return false

    if (Date.now() - a.time > 250) {
      auto = undefined
      return false
    }

    // Time-based only. On iOS, scrollHeight dips can clamp scrollTop to a
    // value far from our intended position, making position checks unreliable.
    // User scrolls are already handled by handleWheel (upward wheel/touch)
    // and handleInteraction (click/tap), so this only needs to guard against
    // false-positive "user scrolled" detection from our own programmatic scrolls.
    return true
  }

  // Circuit breaker: detect anchor oscillation by tracking scroll events
  // that land far from bottom during active streaming. During conclusion
  // streaming, every character triggers ResizeObserver → scrollTop change →
  // iOS anchor fights back. The handleScroll correction may land in
  // bottom-zone and never call the breaker. Instead, count ALL non-bottom
  // scroll events during active streaming as "anchor hits".
  let circuitBroken = false
  let anchorHitTimes: number[] = []

  const recordAnchorHit = () => {
    const now = Date.now()
    anchorHitTimes.push(now)
    // Keep only hits within last 1 second
    while (anchorHitTimes.length > 0 && now - anchorHitTimes[0] > 1000) {
      anchorHitTimes.shift()
    }
    // 3+ anchor hits in 1 second = oscillation loop
    if (anchorHitTimes.length >= 3) {
      circuitBroken = true
      stopRafLoop()
      setMode("free-reading", "circuit-breaker")
      debug("circuit-breaker-tripped", { hits: anchorHitTimes.length })
      if (isScrollIncidentCaptureEnabled()) {
        const el = scroll
        void captureScrollIncident("circuit-breaker-tripped", {
          hits: anchorHitTimes.length,
          metrics: el ? metrics(el) : undefined,
          mode: store.mode,
        })
      }
    }
  }

  // The primary follow-bottom mechanism during streaming is the handleScroll
  // correction: when iOS anchor restoration fires a scroll event, we correct
  // scrollTop synchronously (before paint → flicker-free). The rAF loop below
  // is a lightweight fallback for edge cases where scroll events don't fire.
  let loopActive = false
  const startRafLoop = () => {
    if (loopActive) return
    loopActive = true
    const tick = () => {
      if (!loopActive) return
      const el = scroll
      if (!el || userScrolled() || !active()) {
        loopActive = false
        return
      }
      if (!circuitBroken) {
        const distance = distanceFromBottom(el)
        if (distance > followThreshold()) {
          markAuto(el)
          el.scrollTop = bottomScrollTop(el)
          lastScrollHeight = el.scrollHeight
        }
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  const stopRafLoop = () => {
    loopActive = false
  }

  const scrollToBottomNow = (behavior: ScrollBehavior) => {
    const el = scroll
    if (!el) return
    if (circuitBroken) {
      debug("scroll-apply-circuit-broken", { behavior })
      return
    }
    debug("scroll-apply", { behavior, phase: "before", ...metrics(el) })
    markAuto(el)
    if (behavior === "smooth") {
      el.scrollTo({ top: bottomScrollTop(el), behavior })
      debug("scroll-apply", { behavior, phase: "after-scrollTo", ...metrics(el) })
      return
    }

    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    el.scrollTop = bottomScrollTop(el)
    lastScrollHeight = el.scrollHeight
    debug("scroll-apply", { behavior, phase: "after-assignment", ...metrics(el) })
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

    scrollToBottomNow("auto")
  }

  const stop = (force = false) => {
    const el = scroll
    if (!el) return
    explicitFollow = false
    clearAuto()
    if (!force && !canScroll(el)) {
      if (userScrolled()) setMode("follow-bottom", "no-overflow")
      return
    }
    if (userScrolled()) return

    stopRafLoop()
    setMode("free-reading", "user-stop")
    debug("user-stop")
    options.onUserInteracted?.()
  }

  /**
   * Returns true only when the nested [data-scrollable] element actually
   * has vertical overflow — i.e. it can really consume a vertical scroll
   * gesture. Regions with the attribute but currently-fitting content
   * must NOT suppress root-level scroll handling, otherwise mobile
   * history-lazyload sentinel never arms (2026-04-24 fix).
   */
  const nestedConsumesVerticalScroll = (nested: Element): boolean => {
    if (!(nested instanceof HTMLElement)) return false
    if (nested.scrollHeight <= nested.clientHeight + 1) return false
    const style = window.getComputedStyle(nested)
    const overflowY = style.overflowY
    return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay"
  }

  const handleWheel = (e: WheelEvent) => {
    // If the user is scrolling within a nested scrollable region (tool output,
    // code block, etc) AND that region actually has vertical overflow to
    // consume the scroll, don't treat it as leaving the "follow bottom"
    // mode. For regions that carry [data-scrollable] but whose current
    // content fits (no overflow), the gesture must bubble to root so
    // mobile/desktop history-lazyload is not starved.
    const el = scroll
    const target = e.target instanceof Element ? e.target : undefined
    const nested = target?.closest("[data-scrollable]")
    if (el && nested && nested !== el && nestedConsumesVerticalScroll(nested)) return
    // No scrollable area, or already at bottom: gesture cannot mean "I want to
    // read history". iOS rubber-band, address-bar collapse, and viewport
    // jiggers fire wheel/touch events at the bottom boundary; respecting them
    // strands the user in free-reading.
    if (el && (!canScroll(el) || distanceFromBottom(el) < threshold())) return
    clearAuto()
    stop()
  }

  // iOS touch scrolling doesn't fire wheel events, so track touch movement
  // directly and treat any root-level vertical gesture as reading intent.
  let touchStartY = 0
  let touchActive = false

  const handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    touchStartY = e.touches[0].clientY
    touchActive = true
  }

  const handleTouchMove = (e: TouchEvent) => {
    if (!touchActive || e.touches.length !== 1) return
    const deltaY = e.touches[0].clientY - touchStartY
    if (Math.abs(deltaY) > 10) {
      const el = scroll
      const target = e.target instanceof Element ? e.target : undefined
      const nested = target?.closest("[data-scrollable]")
      // Only suppress if the nested region can actually consume this
      // vertical scroll. Regions with [data-scrollable] but no current
      // overflow (short content) must let the gesture reach root, or
      // mobile history-lazyload never arms — user sees tail 30 only.
      if (el && nested && nested !== el && nestedConsumesVerticalScroll(nested)) return
      // Same boundary guard as handleWheel: at the bottom of a scrollable
      // page, iOS fires touchmove with deltaY > 10 from rubber-band bounce
      // even though scrollTop never moves. Don't strand the user in
      // free-reading on a phantom gesture.
      if (el && (!canScroll(el) || distanceFromBottom(el) < threshold())) {
        touchActive = false
        return
      }
      touchActive = false
      clearAuto()
      stop()
    }
  }

  const handleTouchEnd = () => {
    touchActive = false
  }

  const handleScroll = () => {
    const el = scroll
    if (!el) return

    // Circuit breaker — stop ALL scroll processing immediately.
    if (circuitBroken) return

    if (!canScroll(el)) {
      if (userScrolled()) setMode("follow-bottom", "no-overflow")
      return
    }

    if (distanceFromBottom(el) < threshold()) {
      if (userScrolled() && !options.resumeOnly) setMode("follow-bottom", "bottom-zone")
      debug("handle-scroll-bottom-zone")
      return
    }

    // In free-reading mode, let the user scroll freely. Don't fight
    // iOS anchor restoration here — momentum scrolling after touchEnd
    // is indistinguishable from anchor jumps, and correcting both
    // makes the experience worse. The user can resume follow-bottom
    // by scrolling to the bottom.
    if (userScrolled()) {
      debug("handle-scroll-free-reading")
      return
    }

    // Ignore scroll events triggered by our own scrollToBottom calls.
    if (!userScrolled() && isAuto(el)) {
      debug("handle-scroll-auto")
      return
    }

    if (explicitFollow) {
      markAuto(el)
      el.scrollTop = bottomScrollTop(el)
      lastScrollHeight = el.scrollHeight
      debug("handle-scroll-explicit-follow", metrics(el))
      return
    }

    debug("handle-scroll-user")
    stop()
  }

  const handleInteraction = () => {
    if (!active()) return
    const el = scroll
    if (el && distanceFromBottom(el) < threshold()) {
      debug("interaction-at-bottom-ignored")
      return
    }
    debug("interaction")
    stop()
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
        // Always track scrollHeight even in free-reading mode so that
        // when the user resumes, the delta doesn't include accumulated
        // growth during free-reading.
        if (el) lastScrollHeight = el.scrollHeight
        debug("resize-blocked-user")
        return
      }

      if (!el) return
      const newScrollHeight = el.scrollHeight
      const delta = newScrollHeight - lastScrollHeight
      lastScrollHeight = newScrollHeight

      if (delta === 0) {
        debug("resize-no-delta")
        return
      }

      // Circuit breaker tripped — only track scrollHeight, don't move scrollTop.
      if (circuitBroken) {
        debug("resize-circuit-broken", { delta })
        return
      }

      const distance = distanceFromBottom(el)
      debug("resize-delta", {
        delta,
        distance,
        followThreshold: followThreshold(),
        resumeOnly: options.resumeOnly === true,
      })

      if (distance > followThreshold() && !explicitFollow) {
        stopRafLoop()
        setMode("free-reading", "resize-away-from-bottom", {
          delta,
          distance,
          followThreshold: followThreshold(),
          newScrollHeight,
          prevLastScrollHeight: newScrollHeight - delta,
        })
        debug("resize-blocked-away-from-bottom", { delta, distance, ...metrics(el) })
        return
      }

      markAuto(el)

      let writeTrace: {
        beforeWrite: { scrollTop: number; scrollHeight: number; clientHeight: number }
        afterWrite: { scrollTop: number; scrollHeight: number; clientHeight: number }
        target: number
      } | undefined
      if (delta > 0) {
        const target = bottomScrollTop(el)
        const beforeWrite = {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        }
        el.scrollTop = target
        writeTrace = {
          beforeWrite,
          afterWrite: {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          },
          target,
        }
      }

      // Safety net: if we're far from bottom after the adjustment (or after
      // a scrollHeight shrink caused by SolidJS re-renders clamping scrollTop),
      // snap to bottom. But first check circuit breaker — repeated snaps
      // mean iOS anchor is fighting back every resize cycle.
      const remaining = distanceFromBottom(el)
      if (remaining > followThreshold()) {
        if (isScrollIncidentCaptureEnabled()) {
          let scrollerAnchor: string | undefined
          let firstChildAnchor: string | undefined
          let userMessageAnchor: string | undefined
          let firstChildOuterHTML: string | undefined
          try {
            scrollerAnchor = getComputedStyle(el).overflowAnchor
            const content = store.contentRef
            const first = content?.firstElementChild as HTMLElement | undefined
            firstChildAnchor = first ? getComputedStyle(first).overflowAnchor : undefined
            firstChildOuterHTML = first ? first.outerHTML.slice(0, 240) : undefined
            const userMsg = content?.querySelector<HTMLElement>('[id^="message-"]')
            userMessageAnchor = userMsg ? getComputedStyle(userMsg).overflowAnchor : undefined
          } catch {}
          void captureScrollIncident("anchor-hit", {
            delta,
            remaining,
            followThreshold: followThreshold(),
            explicitFollow,
            circuitBroken,
            anchorHitsPriorToThis: anchorHitTimes.length,
            writeTrace,
            computedAnchors: {
              scroller: scrollerAnchor,
              firstContentChild: firstChildAnchor,
              firstUserMessage: userMessageAnchor,
            },
            firstChildOuterHTML,
            metrics: metrics(el),
            lastScrollHeight,
            mode: store.mode,
          })
        }
        recordAnchorHit()
        if (circuitBroken) {
          debug("resize-circuit-broken-snap", { delta, remaining })
          return
        }
        if (explicitFollow) {
          markAuto(el)
          el.scrollTop = bottomScrollTop(el)
          lastScrollHeight = el.scrollHeight
          debug("resize-explicit-follow-snap", { delta, remaining, ...metrics(el) })
          return
        }
        setMode("free-reading", "resize-remaining-away-from-bottom", {
          delta,
          remaining,
          followThreshold: followThreshold(),
          writeTrace,
          anchorHitsAtFlip: anchorHitTimes.length,
        })
        debug("resize-delta-blocked-snap", { delta, remaining, ...metrics(el) })
      } else {
        debug("resize-bottom-applied", { delta, ...metrics(el) })
      }
    },
  )

  createEffect(
    on(options.working, (working: boolean) => {
      settling = false
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined

      if (working) {
        debug("working-start")
        // Clear any stale message hash so that useSessionHashScroll's
        // applyHash effect doesn't fight follow-bottom by scrolling to
        // a specific message during streaming.
        if (typeof window !== "undefined" && window.location.hash) {
          window.history.replaceState(null, "", window.location.href.replace(/#.*$/, ""))
        }
        if (!userScrolled()) {
          const el = scroll
          if (el && canScroll(el) && distanceFromBottom(el) > threshold() && !explicitFollow) {
            stopRafLoop()
            setMode("free-reading", "working-start-away-from-bottom")
            debug("working-start-blocked-away-from-bottom", metrics(el))
            return
          }
          scrollToBottom(true)
          startRafLoop()
        }
        return
      }

      debug("working-stop")
      stopRafLoop()
      settling = true
      settleTimer = setTimeout(() => {
        settling = false
      }, 300)
    }),
  )

  createEffect(() => {
    store.mode
    store.contentRef
    const el = scroll
    if (!el) return
    // Sync lastScrollHeight when refs change.
    lastScrollHeight = el.scrollHeight
  })

  onCleanup(() => {
    stopRafLoop()
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

      lastScrollHeight = el.scrollHeight
      debug("attach")
      el.addEventListener("wheel", handleWheel, { passive: true })
      el.addEventListener("touchstart", handleTouchStart, { passive: true })
      el.addEventListener("touchmove", handleTouchMove, { passive: true })
      el.addEventListener("touchend", handleTouchEnd, { passive: true })

      cleanup = () => {
        el.removeEventListener("wheel", handleWheel)
        el.removeEventListener("touchstart", handleTouchStart)
        el.removeEventListener("touchmove", handleTouchMove)
        el.removeEventListener("touchend", handleTouchEnd)
      }
    },
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    handleInteraction,
    pause: (force = false) => {
      if (!force) {
        const el = scroll
        // Same boundary guard as handleWheel / handleTouchMove. The JSX-bound
        // onWheel/onTouchMove handlers in the message timeline route through
        // here via onAutoScrollUserIntent; phantom iOS gestures at the bottom
        // boundary must not strand the user in free-reading.
        if (el && (!canScroll(el) || distanceFromBottom(el) < threshold())) return
      }
      stopRafLoop()
      stop(true)
    },
    resume: () => {
      // Reset circuit breaker on explicit user action
      if (circuitBroken) {
        circuitBroken = false
        anchorHitTimes.length = 0
        debug("circuit-breaker-reset-by-user")
      }
      explicitFollow = true
      if (userScrolled()) setMode("follow-bottom", "explicit-resume")
      debug("resume")
      scrollToBottom(true)
      if (active()) startRafLoop()
    },
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => scrollToBottom(true),
    userScrolled,
    mode: () => store.mode,
  }
}
