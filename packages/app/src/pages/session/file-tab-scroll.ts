type Input = {
  prevScrollWidth: number
  scrollWidth: number
  clientWidth: number
  prevContextOpen: boolean
  contextOpen: boolean
}

export const nextTabListScrollLeft = (input: Input) => {
  if (input.scrollWidth <= input.prevScrollWidth) return
  if (!input.prevContextOpen && input.contextOpen) return 0
  if (input.scrollWidth <= input.clientWidth) return
  return input.scrollWidth - input.clientWidth
}

export const createFileTabListSync = (input: { el: HTMLDivElement; contextOpen: () => boolean }) => {
  let frame: number | undefined
  let prevScrollWidth = input.el.scrollWidth
  let prevContextOpen = input.contextOpen()

  const update = () => {
    const scrollWidth = input.el.scrollWidth
    const clientWidth = input.el.clientWidth
    const contextOpen = input.contextOpen()
    const left = nextTabListScrollLeft({
      prevScrollWidth,
      scrollWidth,
      clientWidth,
      prevContextOpen,
      contextOpen,
    })

    if (left !== undefined) {
      input.el.scrollTo({
        left,
        behavior: "smooth",
      })
    }

    prevScrollWidth = scrollWidth
    prevContextOpen = contextOpen
  }

  const schedule = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      update()
    })
  }

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    input.el.scrollLeft += e.deltaY > 0 ? 50 : -50
    e.preventDefault()
  }

  input.el.addEventListener("wheel", onWheel, { passive: false })
  const observer = new MutationObserver(schedule)
  observer.observe(input.el, { childList: true })

  return () => {
    input.el.removeEventListener("wheel", onWheel)
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}

export const scrollTabIntoView = (input: { el: HTMLDivElement; activeTab: string | undefined }) => {
  if (!input.activeTab) return
  const trigger = input.el.querySelector<HTMLElement>(`[data-key="${CSS.escape(input.activeTab)}"]`)
  if (!trigger) return

  // Compute the tab's position relative to the scrollable strip via bounding
  // rects — `offsetLeft` is relative to the nearest positioned ancestor,
  // which (because SortableTab wraps each trigger in `<div class="relative">`)
  // is the tab's own wrapper, not the strip. Using offsetLeft would always
  // report ~0 and yank the strip back to the start whenever an off-screen
  // tab activates.
  const containerRect = input.el.getBoundingClientRect()
  const triggerRect = trigger.getBoundingClientRect()
  const tabLeft = input.el.scrollLeft + (triggerRect.left - containerRect.left)
  const tabRight = tabLeft + triggerRect.width
  const containerLeft = input.el.scrollLeft
  const containerRight = containerLeft + input.el.clientWidth

  if (tabLeft < containerLeft) {
    input.el.scrollTo({ left: tabLeft, behavior: "smooth" })
    return
  }

  if (tabRight > containerRight) {
    input.el.scrollTo({ left: tabRight - input.el.clientWidth, behavior: "smooth" })
  }
}
