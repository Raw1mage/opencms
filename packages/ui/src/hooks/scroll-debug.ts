type ScrollDebugEntry = {
  time: number
  scope: string
  event: string
  userScrolled?: boolean
  active?: boolean
  settling?: boolean
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
  distanceFromBottom?: number
  [key: string]: unknown
}

declare global {
  interface Window {
    __scrollDebugBuffer?: ScrollDebugEntry[]
    __dumpScrollDebug?: (options?: { last?: number; scope?: string }) => ScrollDebugEntry[]
    __flushScrollDebug?: () => Promise<void>
    __opencodeCsrfToken?: string
    __lastScrollDebugFlush?: {
      ok: boolean
      status?: number
      count?: number
      error?: string
      time: number
    }
  }
}

const MAX_BUFFER = 300
const MAX_BATCH = 40
let queued: ScrollDebugEntry[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let inflight: Promise<void> | undefined

export function isScrollDebugEnabled() {
  return typeof window !== "undefined" && window.localStorage.getItem("opencode:scroll-debug") !== "0"
}

function ensureHelpers() {
  if (typeof window === "undefined") return
  window.__dumpScrollDebug ??= (options) => {
    const last = options?.last ?? 80
    const scope = options?.scope
    const source = window.__scrollDebugBuffer ?? []
    const result = scope ? source.filter((item) => item.scope === scope).slice(-last) : source.slice(-last)
    console.table(result)
    return result
  }
  window.__flushScrollDebug ??= () => flushScrollDebug()
}

async function sendBatch(batch: ScrollDebugEntry[]) {
  if (typeof window === "undefined" || batch.length === 0) return
  const headers = new Headers({ "Content-Type": "application/json" })
  const csrf = window.__opencodeCsrfToken
  if (csrf) headers.set("x-opencode-csrf", csrf)
  const response = await fetch("/api/v2/log", {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({
      service: "webapp.scroll-debug",
      level: "debug",
      message: "frontend scroll debug batch",
      extra: {
        count: batch.length,
        events: batch,
      },
    }),
  })
  if (!response.ok) {
    throw new Error(`scroll debug flush failed: ${response.status}`)
  }
}

export async function flushScrollDebug() {
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  if (queued.length === 0) return
  const batch = queued.splice(0, MAX_BATCH)
  inflight = sendBatch(batch)
    .then(() => {
      if (typeof window !== "undefined") {
        window.__lastScrollDebugFlush = {
          ok: true,
          count: batch.length,
          time: Date.now(),
        }
      }
      console.info("[scroll-debug] flush ok", { count: batch.length })
    })
    .catch((error) => {
      if (typeof window !== "undefined") {
        window.__lastScrollDebugFlush = {
          ok: false,
          count: batch.length,
          error: error instanceof Error ? error.message : String(error),
          time: Date.now(),
        }
      }
      console.error("[scroll-debug] flush failed", error)
      queued.unshift(...batch)
    })
    .finally(() => {
      inflight = undefined
      if (queued.length > 0) timer = setTimeout(() => void flushScrollDebug(), 250)
    })
  await inflight
}

export function pushScrollDebug(entry: ScrollDebugEntry) {
  if (!isScrollDebugEnabled()) return
  ensureHelpers()
  if (typeof window !== "undefined") {
    const buffer = (window.__scrollDebugBuffer ??= [])
    buffer.push(entry)
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
  }
  queued.push(entry)
  if (queued.length >= MAX_BATCH) {
    void flushScrollDebug()
    return
  }
  if (timer) return
  timer = setTimeout(() => {
    timer = undefined
    void flushScrollDebug()
  }, 500)
}

export type { ScrollDebugEntry }
