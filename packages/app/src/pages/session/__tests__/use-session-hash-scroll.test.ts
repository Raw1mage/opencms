import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { isServer } from "solid-js/web"
import { useSessionHashScroll, anchor, shouldReplayInitialHash } from "../use-session-hash-scroll"

const testIfClient = isServer ? test.skip : test

describe("useSessionHashScroll", () => {
  let rafCallbacks: FrameRequestCallback[] = []
  let originalRAF = window.requestAnimationFrame
  let originalGlobalRAF = globalThis.requestAnimationFrame
  let originalReplaceState = window.history.replaceState
  let replaceStateCalls: string[] = []

  beforeEach(() => {
    rafCallbacks = []
    replaceStateCalls = []
    const raf = (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return 0
    }
    window.requestAnimationFrame = raf
    globalThis.requestAnimationFrame = raf
    window.history.replaceState = (_state, _title, url) => {
      if (url) replaceStateCalls.push(url.toString())
    }
    document.body.innerHTML = ""
  })

  afterEach(() => {
    window.requestAnimationFrame = originalRAF
    globalThis.requestAnimationFrame = originalGlobalRAF
    window.history.replaceState = originalReplaceState
    window.location.hash = ""
  })

  testIfClient("scrolls to message from hash on load", async () => {
    window.location.hash = `#${anchor("msg-1")}`

    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const [messagesReady, setMessagesReady] = createSignal(false)
        const [turnStart] = createSignal(0)
        let pausedAutoScroll = false

        // Setup DOM
        const scroller = document.createElement("div")
        const msgEl = document.createElement("div")
        msgEl.id = anchor("msg-1")
        document.body.appendChild(scroller)
        document.body.appendChild(msgEl)

        useSessionHashScroll({
          scroller: () => scroller as any,
          messages: () => [{ id: "msg-1", role: "user" } as any],
          messagesReady,
          onActiveChange: () => {},
          onPauseAutoScroll: () => {
            pausedAutoScroll = true
          },
          onScrollToBottom: () => {},
          activeMessageId: () => undefined,
          turnStart,
          onBackfill: () => {},
        })

        // Not ready yet
        expect(pausedAutoScroll).toBe(false)

        // Ready
        setMessagesReady(true)

        // Wait for Effect and RAF
        setTimeout(() => {
          rafCallbacks.forEach((cb) => cb(0))
          expect(pausedAutoScroll).toBe(true)
          dispose()
          resolve()
        }, 50)
      })
    })
  })

  testIfClient("updates hash when scrollToMessage is called", () => {
    createRoot((dispose) => {
      const scroller = document.createElement("div")
      const msgEl = document.createElement("div")
      msgEl.id = anchor("msg-2")
      document.body.appendChild(scroller)
      document.body.appendChild(msgEl)

      const { scrollToMessage } = useSessionHashScroll({
        scroller: () => scroller as any,
        messages: () => [{ id: "msg-2", role: "user" } as any],
        messagesReady: () => true,
        onActiveChange: () => {},
        onPauseAutoScroll: () => {},
        onScrollToBottom: () => {},
        activeMessageId: () => undefined,
        turnStart: () => 0,
        onBackfill: () => {},
      })

      scrollToMessage({ id: "msg-2" } as any)

      expect(replaceStateCalls).toContain(`#${anchor("msg-2")}`)
      dispose()
    })
  })

  testIfClient("triggers backfill if message is before turnStart", () => {
    createRoot((dispose) => {
      const scroller = document.createElement("div")
      document.body.appendChild(scroller)
      let backfillTo: number | undefined

      const { scrollToMessage } = useSessionHashScroll({
        scroller: () => scroller as any,
        messages: () => [
          { id: "msg-0", role: "user" } as any,
          { id: "msg-1", role: "user" } as any,
          { id: "msg-2", role: "user" } as any,
        ],
        messagesReady: () => true,
        onActiveChange: () => {},
        onPauseAutoScroll: () => {},
        onScrollToBottom: () => {},
        activeMessageId: () => undefined,
        turnStart: () => 2, // Only rendering from index 2
        onBackfill: (idx) => {
          backfillTo = idx
        },
      })

      scrollToMessage({ id: "msg-1" } as any)

      expect(backfillTo).toBe(1)
      dispose()
    })
  })

  testIfClient("does not scroll to bottom on initial no-hash load while user scrolled", async () => {
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const scroller = document.createElement("div")
        document.body.appendChild(scroller)
        let scrolledToBottom = false
        let scheduledScrollState = false

        useSessionHashScroll({
          sessionKey: () => "session-a",
          sessionID: () => "session-a",
          messagesReady: () => true,
          working: () => false,
          visibleUserMessages: () => [{ id: "msg-1", role: "user" } as any],
          turnStart: () => 0,
          currentMessageId: () => undefined,
          pendingMessage: () => undefined,
          hasPendingMessage: () => false,
          setPendingMessage: () => {},
          setActiveMessage: () => {},
          setTurnStart: () => {},
          scheduleTurnBackfill: () => {},
          autoScroll: {
            pause: () => {},
            scrollToBottom: () => {
              scrolledToBottom = true
            },
          },
          scroller: () => scroller,
          anchor,
          scheduleScrollState: () => {
            scheduledScrollState = true
          },
          consumePendingMessage: () => undefined,
          userScrolled: () => true,
        })

        setTimeout(() => {
          rafCallbacks.forEach((cb) => cb(0))
          expect(scrolledToBottom).toBe(false)
          expect(scheduledScrollState).toBe(false)
          dispose()
          resolve()
        }, 0)
      })
    })
  })

  testIfClient("keeps explicit message hash navigation while user scrolled", async () => {
    window.location.hash = `#${anchor("msg-3")}`

    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const scroller = document.createElement("div")
        const msgEl = document.createElement("div")
        msgEl.id = anchor("msg-3")
        document.body.appendChild(scroller)
        document.body.appendChild(msgEl)
        let pausedAutoScroll = false
        let scrolledToBottom = false

        useSessionHashScroll({
          sessionKey: () => "session-b",
          sessionID: () => "session-b",
          messagesReady: () => true,
          working: () => false,
          visibleUserMessages: () => [{ id: "msg-3", role: "user" } as any],
          turnStart: () => 0,
          currentMessageId: () => undefined,
          pendingMessage: () => undefined,
          hasPendingMessage: () => true,
          setPendingMessage: () => {},
          setActiveMessage: () => {},
          setTurnStart: () => {},
          scheduleTurnBackfill: () => {},
          autoScroll: {
            pause: () => {
              pausedAutoScroll = true
            },
            scrollToBottom: () => {
              scrolledToBottom = true
            },
          },
          scroller: () => scroller,
          anchor,
          scheduleScrollState: () => {},
          consumePendingMessage: () => undefined,
          userScrolled: () => true,
        })

        setTimeout(() => {
          rafCallbacks.forEach((cb) => cb(0))
          expect(pausedAutoScroll).toBe(true)
          expect(scrolledToBottom).toBe(false)
          dispose()
          resolve()
        }, 0)
      })
    })
  })

  testIfClient("clears stale message hash and returns to bottom", () => {
    window.location.hash = `#${anchor("missing-msg")}`

    createRoot((dispose) => {
      const scroller = document.createElement("div")
      document.body.appendChild(scroller)
      let pausedAutoScroll = false
      let scrolledToBottom = false
      let scheduledScrollState = false

      const hashScroll = useSessionHashScroll({
        sessionKey: () => "session-c",
        sessionID: () => "session-c",
        messagesReady: () => true,
        working: () => false,
        visibleUserMessages: () => [{ id: "tail-msg", role: "user" } as any],
        turnStart: () => 0,
        currentMessageId: () => undefined,
        pendingMessage: () => undefined,
        hasPendingMessage: () => false,
        setPendingMessage: () => {},
        setActiveMessage: () => {},
        setTurnStart: () => {},
        scheduleTurnBackfill: () => {},
        autoScroll: {
          pause: () => {
            pausedAutoScroll = true
          },
          scrollToBottom: () => {
            scrolledToBottom = true
          },
        },
        scroller: () => scroller,
        anchor,
        scheduleScrollState: () => {
          scheduledScrollState = true
        },
        consumePendingMessage: () => undefined,
        userScrolled: () => false,
      })

      hashScroll.applyHash("auto")

      expect(pausedAutoScroll).toBe(false)
      expect(scrolledToBottom).toBe(true)
      expect(scheduledScrollState).toBe(true)
      expect(replaceStateCalls.length).toBeGreaterThan(0)
      dispose()
    })
  })

  test("does not replay valid message hash without pending navigation", () => {
    expect(shouldReplayInitialHash(`#${anchor("msg-4")}`, false, false)).toBe(false)
    expect(shouldReplayInitialHash(`#${anchor("msg-4")}`, true, false)).toBe(true)
    expect(shouldReplayInitialHash(`#${anchor("msg-4")}`, true, true)).toBe(false)
    expect(shouldReplayInitialHash("#review-panel", false, true)).toBe(true)
  })

  test("does not jump to message hash while free reading", () => {
    window.location.hash = `#${anchor("msg-5")}`

    createRoot((dispose) => {
      const scroller = document.createElement("div")
      const msgEl = document.createElement("div")
      msgEl.id = anchor("msg-5")
      document.body.appendChild(scroller)
      document.body.appendChild(msgEl)
      let pausedAutoScroll = false
      let scrolledToBottom = false

      const hashScroll = useSessionHashScroll({
        sessionKey: () => "session-e",
        sessionID: () => "session-e",
        messagesReady: () => true,
        working: () => false,
        visibleUserMessages: () => [{ id: "msg-5", role: "user" } as any],
        turnStart: () => 0,
        currentMessageId: () => undefined,
        pendingMessage: () => undefined,
        hasPendingMessage: () => true,
        setPendingMessage: () => {},
        setActiveMessage: () => {},
        setTurnStart: () => {},
        scheduleTurnBackfill: () => {},
        autoScroll: {
          pause: () => {
            pausedAutoScroll = true
          },
          scrollToBottom: () => {
            scrolledToBottom = true
          },
        },
        scroller: () => scroller,
        anchor,
        scheduleScrollState: () => {},
        consumePendingMessage: () => undefined,
        userScrolled: () => true,
      })

      hashScroll.applyHash("auto")

      expect(pausedAutoScroll).toBe(false)
      expect(scrolledToBottom).toBe(false)
      expect(replaceStateCalls.length).toBeGreaterThan(0)
      dispose()
    })
  })
})
