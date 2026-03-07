import { describe, expect, test } from "bun:test"
import { nextTabListScrollLeft, scrollTabIntoView } from "./file-tab-scroll"

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
  test("scrolls left when active tab is left of viewport", () => {
    const calls: Array<{ left: number; behavior: string }> = []
    const scrollTo = (input: { left: number; behavior: string }) => calls.push(input)
    const el = {
      scrollLeft: 120,
      clientWidth: 200,
      querySelector: () => ({ offsetLeft: 40, offsetWidth: 80 }),
      scrollTo,
    } as unknown as HTMLDivElement

    scrollTabIntoView({ el, activeTab: "a.ts" })

    expect(calls).toEqual([{ left: 40, behavior: "smooth" }])
  })

  test("scrolls right when active tab is right of viewport", () => {
    const calls: Array<{ left: number; behavior: string }> = []
    const scrollTo = (input: { left: number; behavior: string }) => calls.push(input)
    const el = {
      scrollLeft: 20,
      clientWidth: 200,
      querySelector: () => ({ offsetLeft: 190, offsetWidth: 90 }),
      scrollTo,
    } as unknown as HTMLDivElement

    scrollTabIntoView({ el, activeTab: "b.ts" })

    expect(calls).toEqual([{ left: 80, behavior: "smooth" }])
  })
})
