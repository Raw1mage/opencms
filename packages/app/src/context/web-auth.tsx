import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, createResource, createSignal } from "solid-js"
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
          // Gateway mode: auth is handled by the gateway (PAM), not the SPA.
          // If we get 401 here, the gateway JWT is still valid (otherwise
          // gateway itself would have returned a redirect/clear-cookie).
          // This likely means the daemon is temporarily unavailable.
          // Do NOT redirect — just propagate the error to the caller.
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
