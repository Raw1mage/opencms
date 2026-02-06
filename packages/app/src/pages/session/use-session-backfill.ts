import { createEffect, on } from "solid-js"
import { useParams } from "@solidjs/router"

interface BackfillOptions {
  scroller: () => HTMLDivElement | undefined
  messagesReady: () => boolean
  messageCount: () => number
  onBackfill: (start: number) => void
  turnStart: () => number
}

export function useSessionBackfill(options: BackfillOptions) {
  const params = useParams()
  const turnInit = 20
  const turnBatch = 20
  let turnHandle: number | undefined
  let turnIdle = false

  function cancelTurnBackfill() {
    const handle = turnHandle
    if (handle === undefined) return
    turnHandle = undefined

    if (turnIdle && window.cancelIdleCallback) {
      window.cancelIdleCallback(handle)
      return
    }

    clearTimeout(handle)
  }

  function scheduleTurnBackfill() {
    if (turnHandle !== undefined) return
    if (options.turnStart() <= 0) return

    if (window.requestIdleCallback) {
      turnIdle = true
      turnHandle = window.requestIdleCallback(() => {
        turnHandle = undefined
        backfillTurns()
      })
      return
    }

    turnIdle = false
    turnHandle = window.setTimeout(() => {
      turnHandle = undefined
      backfillTurns()
    }, 0)
  }

  function backfillTurns() {
    const start = options.turnStart()
    if (start <= 0) return

    const next = start - turnBatch
    const nextStart = next > 0 ? next : 0

    const el = options.scroller()
    if (!el) {
      options.onBackfill(nextStart)
      scheduleTurnBackfill()
      return
    }

    const beforeTop = el.scrollTop
    const beforeHeight = el.scrollHeight

    options.onBackfill(nextStart)

    requestAnimationFrame(() => {
      const delta = el.scrollHeight - beforeHeight
      if (!delta) return
      el.scrollTop = beforeTop + delta
    })

    scheduleTurnBackfill()
  }

  createEffect(
    on(
      () => [params.id, options.messagesReady()] as const,
      ([id, ready]) => {
        cancelTurnBackfill()
        options.onBackfill(0)
        if (!id || !ready) return

        const len = options.messageCount()
        const start = len > turnInit ? len - turnInit : 0
        options.onBackfill(start)
        scheduleTurnBackfill()
      },
      { defer: true },
    ),
  )

  return { scheduleTurnBackfill, cancelTurnBackfill }
}
