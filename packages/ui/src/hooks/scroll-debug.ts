type ScrollDebugEntry = {
  time: number
  scope: string
  event: string
  userScrolled?: boolean
  mode?: string
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
let recentSessionPage: ScrollDebugEntry[] = []
let recentViewportBlocks: ScrollDebugEntry[] = []
let recentTurnLayout: ScrollDebugEntry[] = []
let lastAutoCapture = 0

const AUTO_CAPTURE_COOLDOWN_MS = 2000

async function sendAutoCapture(capture: ScrollDebugEntry) {
  if (typeof window === "undefined") return
  const headers = new Headers({ "Content-Type": "application/json" })
  const csrf = window.__opencodeCsrfToken
  if (csrf) headers.set("x-opencode-csrf", csrf)
  const response = await fetch("/api/v2/experimental/scroll-capture", {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({
      source: "webapp.scroll-debug",
      capturedAt: capture.time,
      payload: capture,
    }),
  })
  if (!response.ok) {
    throw new Error(`scroll auto-capture upload failed: ${response.status}`)
  }
}

function recordRecent(entry: ScrollDebugEntry) {
  if (entry.scope === "session-page") {
    recentSessionPage.push(entry)
    if (recentSessionPage.length > 20) recentSessionPage.splice(0, recentSessionPage.length - 20)
    if (entry.event === "viewport-blocks") {
      recentViewportBlocks.push(entry)
      if (recentViewportBlocks.length > 8) recentViewportBlocks.splice(0, recentViewportBlocks.length - 8)
    }
    return
  }

  if (entry.scope === "session-turn-layout") {
    recentTurnLayout.push(entry)
    if (recentTurnLayout.length > 24) recentTurnLayout.splice(0, recentTurnLayout.length - 24)
  }
}

function shouldAutoCapture(entry: ScrollDebugEntry) {
  if (entry.scope !== "session-page") return
  if (entry.mode !== "follow-bottom") return
  const now = Date.now()
  if (now - lastAutoCapture < AUTO_CAPTURE_COOLDOWN_MS) return

  const recent = recentSessionPage.slice(-8)
  if (recent.length < 4) return

  const distances = recent
    .map((item) => (typeof item.distanceFromBottom === "number" ? item.distanceFromBottom : undefined))
    .filter((value): value is number => value !== undefined)

  const scrollApplies = recent.filter((item) => item.event === "scroll-apply").length
  const resizeFollows = recent.filter((item) => item.event === "resize-follow").length
  const bottomFormula = recent.filter((item) => item.event === "bottom-formula").length
  const userStops = recent.filter((item) => item.event === "user-stop").length

  if (userStops > 0) return

  const underFollow =
    distances.length >= 3 &&
    distances.slice(-3).every((value) => value > 24) &&
    (scrollApplies > 0 || resizeFollows > 0 || bottomFormula > 0)

  const widenedConclusionCapture =
    distances.length >= 4 &&
    (resizeFollows >= 2 || scrollApplies >= 2 || bottomFormula >= 3) &&
    Math.max(...distances) >= 14 &&
    Math.max(...distances) - Math.min(...distances) >= 10

  let oscillation = false
  if (distances.length >= 4) {
    let toggles = 0
    for (let i = 1; i < distances.length; i++) {
      const prev = distances[i - 1]!
      const next = distances[i]!
      const prevNear = prev <= 6
      const nextNear = next <= 6
      const delta = Math.abs(next - prev)
      if (prevNear !== nextNear && delta >= 18) toggles++
    }
    oscillation = toggles >= 2 && scrollApplies >= 2
  }

  if (!underFollow && !oscillation && !widenedConclusionCapture) return

  lastAutoCapture = now
  const kind = oscillation ? "oscillation" : underFollow ? "under-follow" : "conclusion-stream-instability"
  const captureID = `scrollcap-${now}`
  const capture: ScrollDebugEntry = {
    time: now,
    scope: "scroll-auto-capture",
    event: "auto-capture",
    marker: "OPENCODE_SCROLL_AUTO_CAPTURE",
    captureID,
    kind,
    recentEvents: recent.map((item) => ({
      scope: item.scope,
      event: item.event,
      distanceFromBottom: item.distanceFromBottom,
      scrollTop: item.scrollTop,
      scrollHeight: item.scrollHeight,
      clientHeight: item.clientHeight,
    })),
    latestViewportBlocks: recentViewportBlocks.at(-1)
      ? {
          time: recentViewportBlocks.at(-1)?.time,
          blocks: recentViewportBlocks.at(-1)?.blocks,
          scrollTop: recentViewportBlocks.at(-1)?.scrollTop,
          distanceFromBottom: recentViewportBlocks.at(-1)?.distanceFromBottom,
        }
      : undefined,
    recentTurnLayout: recentTurnLayout.slice(-6).map((item) => ({
      time: item.time,
      section: item.section,
      messageID: item.messageID,
      working: item.working,
      stepsExpanded: item.stepsExpanded,
      rectTop: item.rectTop,
      rectBottom: item.rectBottom,
      rectHeight: item.rectHeight,
      relativeTop: item.relativeTop,
      relativeBottom: item.relativeBottom,
      scrollTop: item.scrollTop,
      distanceFromBottom: item.distanceFromBottom,
    })),
  }

  if (typeof window !== "undefined") {
    const buffer = (window.__scrollDebugBuffer ??= [])
    buffer.push(capture)
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
    window.localStorage.setItem(
      "opencode:scroll-auto-capture:last",
      JSON.stringify({
        marker: capture.marker,
        captureID,
        kind,
        time: now,
        recentEvents: capture.recentEvents,
      }),
    )
  }
  queued.push(capture)
  if (isScrollDebugEnabled()) console.warn("[scroll-debug] auto-capture", capture)
  void sendAutoCapture(capture).catch((error) => {
    if (isScrollDebugEnabled()) console.error("[scroll-debug] auto-capture upload failed", error)
  })
  void flushScrollDebug()
}

export function isScrollDebugEnabled() {
  return false // typeof window !== "undefined" && window.localStorage.getItem("opencode:scroll-debug") === "1"
}

export const SCROLL_INCIDENT_FLAG = "opencode:scroll-incident"

export function isScrollIncidentCaptureEnabled() {
  return typeof window !== "undefined" && window.localStorage.getItem(SCROLL_INCIDENT_FLAG) === "1"
}

let lastIncidentCapture = 0
const INCIDENT_COOLDOWN_MS = 800

export async function captureScrollIncident(kind: string, payload: Record<string, unknown>) {
  if (!isScrollIncidentCaptureEnabled()) return
  if (typeof window === "undefined") return
  const now = Date.now()
  if (now - lastIncidentCapture < INCIDENT_COOLDOWN_MS) return
  lastIncidentCapture = now
  const captureID = `scrollcap-${now}`
  const capture: ScrollDebugEntry = {
    time: now,
    scope: "scroll-incident",
    event: "anchor-incident",
    marker: "OPENCODE_SCROLL_ANCHOR_INCIDENT",
    captureID,
    kind,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 240) : undefined,
    visualViewportHeight: window.visualViewport?.height,
    visualViewportOffsetTop: window.visualViewport?.offsetTop,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    url: window.location.href,
    ...payload,
  }
  try {
    const buffer = (window.__scrollDebugBuffer ??= [])
    buffer.push(capture)
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
    window.localStorage.setItem(
      "opencode:scroll-incident:last",
      JSON.stringify({ captureID, kind, time: now, payload }),
    )
  } catch {}
  try {
    await sendAutoCapture(capture)
  } catch (error) {
    if (typeof console !== "undefined") {
      console.error("[scroll-incident] upload failed", error)
    }
  }
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
      if (isScrollDebugEnabled()) console.info("[scroll-debug] flush ok", { count: batch.length })
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
      if (isScrollDebugEnabled()) console.error("[scroll-debug] flush failed", error)
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
  recordRecent(entry)
  if (typeof window !== "undefined") {
    const buffer = (window.__scrollDebugBuffer ??= [])
    buffer.push(entry)
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
  }
  queued.push(entry)
  shouldAutoCapture(entry)
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
