import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useServer } from "@/context/server"

type SessionStatus = {
  enabled: boolean
  authenticated: boolean
  usernameHint?: string
  username?: string
  csrfToken?: string
  lockout?: {
    lockedUntil: number
    retryAfterSeconds: number
  }
}

type LoginResult =
  | {
      ok: true
    }
  | {
      ok: false
      message: string
    }

function isMutation(method: string) {
  const upper = method.toUpperCase()
  return !(upper === "GET" || upper === "HEAD" || upper === "OPTIONS")
}

export const { use: useWebAuth, provider: WebAuthProvider } = createSimpleContext({
  name: "WebAuth",
  init: () => {
    const server = useServer()
    const fetcher = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { credentials: "include", ...init })

    const [session, sessionActions] = createResource(
      () => server.url,
      async (baseUrl): Promise<SessionStatus> => {
        try {
          const response = await fetcher(`${baseUrl}/global/auth/session`)
          if (!response.ok) {
            if (response.status === 404) {
              return { enabled: false, authenticated: true }
            }
            return { enabled: true, authenticated: false }
          }
          return (await response.json()) as SessionStatus
        } catch {
          return { enabled: true, authenticated: false }
        }
      },
    )
    const [forcedUnauthenticated, setForcedUnauthenticated] = createSignal(false)

    const csrfToken = createMemo(() => session.latest?.csrfToken)
    const authenticated = createMemo(() => {
      if (forcedUnauthenticated()) return false
      const current = session.latest
      if (!current) return false
      if (!current.enabled) return true
      return current.authenticated
    })
    const enabled = createMemo(() => !!session.latest?.enabled)

    const authorizedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const headers = new Headers(request.headers)
      if (isMutation(request.method)) {
        const csrf = csrfToken()
        if (csrf) headers.set("x-opencode-csrf", csrf)
      }
      const next = new Request(request, {
        headers,
        credentials: "include",
      })
      const response = await fetch(next)
      if (response.status === 401 || response.status === 403) {
        if (!enabled()) {
          // Gateway mode: 401 may mean (a) JWT expired, or (b) daemon temporarily
          // unavailable during reload. Probe gateway health before nuking the cookie.
          // If gateway itself is healthy, the JWT is the problem → redirect to login.
          // If gateway is also down, the daemon is restarting → just propagate error.
          try {
            const probe = await fetch(`${server.url}/global/health`, { credentials: "include" })
            if (probe.ok) {
              // Gateway is healthy but rejected our request → JWT is bad
              document.cookie = "oc_jwt=; Path=/; Max-Age=0"
              window.location.replace("/")
            }
            // else: gateway also unhealthy → transient, don't clear cookie
          } catch {
            // Network error → transient, don't clear cookie
          }
          throw new Error("__OPENCODE_SILENT_UNAUTHORIZED__")
        }
        setForcedUnauthenticated(true)
        void sessionActions.refetch()
        throw new Error("__OPENCODE_SILENT_UNAUTHORIZED__")
      }
      return response
    }

    const login = async (username: string, password: string): Promise<LoginResult> => {
      const response = await fetcher(`${server.url}/global/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      })

      if (!response.ok) {
        let message = `Login failed (${response.status})`
        try {
          const payload = (await response.json()) as { message?: string }
          if (payload?.message) message = payload.message
        } catch {}
        void sessionActions.refetch()
        return { ok: false, message }
      }

      await sessionActions.refetch()
      setForcedUnauthenticated(false)
      return { ok: true }
    }

    const logout = async () => {
      await fetcher(`${server.url}/global/auth/logout`, {
        method: "POST",
        headers: csrfToken() ? { "x-opencode-csrf": csrfToken()! } : undefined,
      }).catch(() => undefined)
      // Clear gateway JWT cookie client-side (not HttpOnly, set via JS by gateway).
      // Belt-and-suspenders: server also sends Set-Cookie, but reverse proxies may strip it.
      document.cookie = "oc_jwt=; Path=/; Max-Age=0"
      setForcedUnauthenticated(true)
      await sessionActions.refetch()
    }

    createEffect(() => {
      const current = session.latest
      if (!current) return
      if (!current.enabled || current.authenticated) setForcedUnauthenticated(false)
    })

    createEffect(() => {
      if (typeof window === "undefined") return
      window.__opencodeCsrfToken = csrfToken() ?? undefined
    })

    // Gateway mode: sliding JWT renewal every 30 minutes.
    // The gateway issues fresh cookies when the JWT is past 50% lifetime.
    const JWT_RENEW_INTERVAL_MS = 30 * 60 * 1000
    createEffect(() => {
      if (enabled()) return // SPA auth mode — renewal not needed
      const url = `${server.url}/auth/renew`
      const renew = () => fetch(url, { credentials: "include" }).catch(() => {})
      renew() // initial renewal attempt on load
      const timer = setInterval(renew, JWT_RENEW_INTERVAL_MS)
      onCleanup(() => clearInterval(timer))
    })

    return {
      loading: () => session.loading,
      session: () => session.latest,
      enabled,
      authenticated,
      csrfToken,
      login,
      logout,
      refetch: () => sessionActions.refetch(),
      authorizedFetch,
    }
  },
})
