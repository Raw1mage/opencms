import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { useSessionBackfill } from "../use-session-backfill"

// Mock router using a signal to allow dynamic changes
const [mockParams, setMockParams] = createSignal({ id: "test-session" })
mock.module("@solidjs/router", () => ({
  useParams: () => mockParams(),
}))

describe("useSessionBackfill", () => {
  let rafCallbacks: FrameRequestCallback[] = []
  let idleCallbacks: Function[] = []
  let originalRAF = window.requestAnimationFrame
  let originalRIC = window.requestIdleCallback

  beforeEach(() => {
    rafCallbacks = []
    idleCallbacks = []
    window.requestAnimationFrame = (cb) => {
      rafCallbacks.push(cb)
      return 0
    }
    // @ts-ignore
    window.requestIdleCallback = (cb) => {
      idleCallbacks.push(cb)
      return 0
    }
  })

  afterEach(() => {
    window.requestAnimationFrame = originalRAF
    window.requestIdleCallback = originalRIC
  })

  test("initializes backfill on session load", async () => {
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

  test("adjusts scroll top when backfilling", async () => {
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
        rafCallbacks.forEach(cb => cb(0))
        
        // Expect scrollTop to be adjusted: beforeTop(100) + delta(700-500) = 300
        expect(mockScroller.scrollTop).toBe(300)

        dispose()
        resolve()
      })
    })
  })
})
