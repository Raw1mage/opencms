/**
 * Click-to-inspect helper for layout debugging.
 *
 * Activate from the browser console:
 *   localStorage.setItem("opencode:inspect", "1"); location.reload()
 *
 * Then any click POSTs target + ancestor chain to
 * /api/v2/experimental/client-diag where the daemon logs it to debug.log
 * (server-side, grep-able). Also mirrored to console for live feedback.
 *
 * Disable:
 *   localStorage.removeItem("opencode:inspect"); location.reload()
 */
const FLAG = "opencode:inspect"
const MAX_DEPTH = 12
const ENDPOINT = "/api/v2/experimental/client-diag"

const summarize = (el: Element) => {
  const html = el as HTMLElement
  const cs = window.getComputedStyle(html)
  const rect = html.getBoundingClientRect()
  const cls = html.className && typeof html.className === "string" ? html.className : (html.getAttribute("class") ?? "")
  return {
    tag: html.tagName.toLowerCase(),
    "data-slot": html.dataset.slot ?? null,
    "data-component": html.dataset.component ?? null,
    id: html.id || null,
    class: cls.length > 120 ? cls.slice(0, 120) + "…" : cls || null,
    display: cs.display,
    position: cs.position,
    flex: cs.display.includes("flex") ? `${cs.flexDirection} wrap=${cs.flexWrap} gap=${cs.gap}` : null,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    },
  }
}

export function installClickInspect() {
  if (typeof window === "undefined" || typeof document === "undefined") return
  let enabled = false
  try {
    enabled = localStorage.getItem(FLAG) === "1"
  } catch {}
  if (!enabled) return

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const chain: ReturnType<typeof summarize>[] = []
      let cur: Element | null = target
      let depth = 0
      while (cur && depth < MAX_DEPTH) {
        chain.push(summarize(cur))
        cur = cur.parentElement
        depth++
      }
      const label =
        `${chain[0].tag}` +
        (chain[0]["data-slot"] ? `[${chain[0]["data-slot"]}]` : "") +
        (chain[0]["data-component"] ? `{${chain[0]["data-component"]}}` : "")
      // eslint-disable-next-line no-console
      console.groupCollapsed(`[inspect] click → ${label}`)
      // eslint-disable-next-line no-console
      console.log("target:", chain[0])
      // eslint-disable-next-line no-console
      console.log("ancestors:", chain.slice(1))
      // eslint-disable-next-line no-console
      console.groupEnd()

      const sessionID = (() => {
        const m = window.location.pathname.match(/\/session\/([A-Za-z0-9_-]+)/)
        return m?.[1]
      })()
      const payload = {
        sessionID,
        note: "click-inspect",
        snapshot: {
          label,
          href: window.location.href,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          target: chain[0],
          ancestors: chain.slice(1),
          at: new Date().toISOString(),
        },
      }
      try {
        const csrf = (window as unknown as { __opencodeCsrfToken?: string }).__opencodeCsrfToken
        const headers: Record<string, string> = { "content-type": "application/json" }
        if (csrf) headers["x-opencode-csrf"] = csrf
        void fetch(ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {})
      } catch {
        // best effort
      }
    },
    true, // capture phase so we see it before app handlers stop propagation
  )

  // eslint-disable-next-line no-console
  console.log(
    "[inspect] click-to-inspect enabled — POSTing to " +
      ENDPOINT +
      '. localStorage.removeItem("opencode:inspect") + reload to disable.',
  )
}
