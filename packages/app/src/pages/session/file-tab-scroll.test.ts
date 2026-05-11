import { describe, expect, test } from "bun:test"
import { nextTabListScrollLeft, scrollTabIntoView } from "./file-tab-scroll"

// Bun's test runtime has no DOM, so polyfill the bits scrollTabIntoView reaches for.
;(globalThis as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s }

describe("nextTabListScrollLeft", () => {
  test("does not scroll when width shrinks", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 500,
      scrollWidth: 420,
      clientWidth: 300,
      prevContextOpen: false,
      contextOpen: false,
    })

    expect(left).toBeUndefined()
  })

  test("scrolls to start when context tab opens", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 400,
      scrollWidth: 500,
      clientWidth: 320,
      prevContextOpen: false,
      contextOpen: true,
    })

    expect(left).toBe(0)
  })

  test("scrolls to right edge for new file tabs", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 500,
      scrollWidth: 780,
      clientWidth: 300,
      prevContextOpen: true,
      contextOpen: true,
    })

    expect(left).toBe(480)
  })
})

describe("scrollTabIntoView", () => {
  const makeEl = (input: {
    scrollLeft: number
    clientWidth: number
    containerLeft: number
    triggerLeft: number
    triggerWidth: number
  }) => {
    const calls: Array<{ left: number; behavior: string }> = []
    const el = {
      scrollLeft: input.scrollLeft,
      clientWidth: input.clientWidth,
      getBoundingClientRect: () => ({ left: input.containerLeft }),
      querySelector: () => ({
        getBoundingClientRect: () => ({ left: input.triggerLeft, width: input.triggerWidth }),
      }),
      scrollTo: (call: { left: number; behavior: string }) => calls.push(call),
    } as unknown as HTMLDivElement

    return { el, calls }
  }

  test("scrolls left when active tab is left of viewport", () => {
    // Tab natural position 40, viewport scrolled to 120 → tab is off-screen-left.
    const { el, calls } = makeEl({
      scrollLeft: 120,
      clientWidth: 200,
      containerLeft: 0,
      triggerLeft: 40 - 120, // triggerRect.left = absoluteLeft - scrollLeft
      triggerWidth: 80,
    })

    scrollTabIntoView({ el, activeTab: "a.ts" })

    expect(calls).toEqual([{ left: 40, behavior: "smooth" }])
  })

  test("scrolls right when active tab is right of viewport", () => {
    // Tab natural position 190, width 90 → right edge 280. Viewport scrollLeft=20, clientWidth=200 → right edge 220. Tab spills past.
    const { el, calls } = makeEl({
      scrollLeft: 20,
      clientWidth: 200,
      containerLeft: 0,
      triggerLeft: 190 - 20,
      triggerWidth: 90,
    })

    scrollTabIntoView({ el, activeTab: "b.ts" })

    expect(calls).toEqual([{ left: 80, behavior: "smooth" }])
  })

  test("does not scroll when active tab is already visible", () => {
    const { el, calls } = makeEl({
      scrollLeft: 100,
      clientWidth: 300,
      containerLeft: 0,
      triggerLeft: 150 - 100,
      triggerWidth: 80,
    })

    scrollTabIntoView({ el, activeTab: "c.ts" })

    expect(calls).toEqual([])
  })
})
