import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { useSessionHashScroll, anchor } from "../use-session-hash-scroll"

describe("useSessionHashScroll", () => {
  let rafCallbacks: FrameRequestCallback[] = []
  let originalRAF = window.requestAnimationFrame
  let originalReplaceState = window.history.replaceState
  let replaceStateCalls: string[] = []

  beforeEach(() => {
    rafCallbacks = []
    replaceStateCalls = []
    window.requestAnimationFrame = (cb) => {
      rafCallbacks.push(cb)
      return 0
    }
    window.history.replaceState = (_state, _title, url) => {
      if (url) replaceStateCalls.push(url.toString())
    }
    document.body.innerHTML = ""
  })

  afterEach(() => {
    window.requestAnimationFrame = originalRAF
    window.history.replaceState = originalReplaceState
    window.location.hash = ""
  })

  test("scrolls to message from hash on load", async () => {
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
          onPauseAutoScroll: () => { pausedAutoScroll = true },
          onForceScrollToBottom: () => {},
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
          rafCallbacks.forEach(cb => cb(0))
          expect(pausedAutoScroll).toBe(true)
          dispose()
          resolve()
        }, 50)
      })
    })
  })

  test("updates hash when scrollToMessage is called", () => {
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
        onForceScrollToBottom: () => {},
        activeMessageId: () => undefined,
        turnStart: () => 0,
        onBackfill: () => {},
      })

      scrollToMessage({ id: "msg-2" } as any)
      
      expect(replaceStateCalls).toContain(`#${anchor("msg-2")}`)
      dispose()
    })
  })

  test("triggers backfill if message is before turnStart", () => {
    createRoot((dispose) => {
      const scroller = document.createElement("div")
      document.body.appendChild(scroller)
      let backfillTo: number | undefined

      const { scrollToMessage } = useSessionHashScroll({
        scroller: () => scroller as any,
        messages: () => [
          { id: "msg-0", role: "user" } as any,
          { id: "msg-1", role: "user" } as any,
          { id: "msg-2", role: "user" } as any
        ],
        messagesReady: () => true,
        onActiveChange: () => {},
        onPauseAutoScroll: () => {},
        onForceScrollToBottom: () => {},
        activeMessageId: () => undefined,
        turnStart: () => 2, // Only rendering from index 2
        onBackfill: (idx) => { backfillTo = idx },
      })

      scrollToMessage({ id: "msg-1" } as any)
      
      expect(backfillTo).toBe(1)
      dispose()
    })
  })
})
