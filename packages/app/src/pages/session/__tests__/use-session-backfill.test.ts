import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { isServer } from "solid-js/web"

// Mock router using a signal to allow dynamic changes
const [mockParams, setMockParams] = createSignal({ id: "test-session" })
mock.module("@solidjs/router", () => ({
  useParams: () => mockParams(),
}))

const { useSessionBackfill } = await import("../use-session-backfill")
const testIfClient = isServer ? test.skip : test

describe("useSessionBackfill", () => {
  let rafCallbacks: FrameRequestCallback[] = []
  let idleCallbacks: Function[] = []
  let originalRAF = window.requestAnimationFrame
  let originalGlobalRAF = globalThis.requestAnimationFrame
  let originalRIC = window.requestIdleCallback
  let originalGlobalRIC = globalThis.requestIdleCallback

  beforeEach(() => {
    rafCallbacks = []
    idleCallbacks = []
    const raf = (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return 0
    }
    const ric = (cb: IdleRequestCallback) => {
      idleCallbacks.push(cb)
      return 0
    }
    window.requestAnimationFrame = raf
    globalThis.requestAnimationFrame = raf
    window.requestIdleCallback = ric
    globalThis.requestIdleCallback = ric
  })

  afterEach(() => {
    window.requestAnimationFrame = originalRAF
    globalThis.requestAnimationFrame = originalGlobalRAF
    window.requestIdleCallback = originalRIC
    globalThis.requestIdleCallback = originalGlobalRIC
  })

  testIfClient("initializes backfill on session load", async () => {
    let backfillValue = -1

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out: backfillValue is ${backfillValue}`)), 2000)

      createRoot((dispose) => {
        const [messagesReady, setMessagesReady] = createSignal(false)
        const [turnStart, setTurnStart] = createSignal(0)

        useSessionBackfill({
          scroller: () => undefined,
          messagesReady,
          messageCount: () => 100,
          onBackfill: (v) => {
            backfillValue = v
            // The effect first sets it to 0, then to 80
            if (v === 80) {
              clearTimeout(timeout)
              dispose()
              resolve()
            }
          },
          turnStart,
        })

        // Wait a bit before changing the signal to ensure defer: true works
        setTimeout(() => {
          setMessagesReady(true)
        }, 50)
      })
    })

    expect(backfillValue).toBe(80)
  })

  testIfClient("adjusts scroll top when backfilling", async () => {
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const [turnStart, setTurnStart] = createSignal(40)
        let backfillValue = 40

        const mockScroller = {
          scrollTop: 100,
          scrollHeight: 500,
        }

        const { scheduleTurnBackfill } = useSessionBackfill({
          scroller: () => mockScroller as any,
          messagesReady: () => true,
          messageCount: () => 100,
          onBackfill: (v) => {
            backfillValue = v
          },
          turnStart,
        })

        // Trigger backfill logic
        scheduleTurnBackfill()

        // requestIdleCallback should have been called
        expect(idleCallbacks.length).toBe(1)

        // Capture height before height change
        const beforeHeight = mockScroller.scrollHeight // 500

        // Execute idle callback (which calls backfillTurns)
        idleCallbacks[0]()

        // After backfillTurns, onBackfill should be called with next start (40 - 20 = 20)
        expect(backfillValue).toBe(20)

        // Simulate height change after new messages rendered
        mockScroller.scrollHeight = 700

        // Execute RAF callbacks
        rafCallbacks.forEach((cb) => cb(0))

        // Expect scrollTop to be adjusted: beforeTop(100) + delta(700-500) = 300
        expect(mockScroller.scrollTop).toBe(300)

        dispose()
        resolve()
      })
    })
  })
})
