/**
 * Web route API client — lightweight fetch wrapper over /api/v2/web-route endpoints.
 * Uses globalSDK.fetch for auth; does NOT modify the auto-generated SDK.
 */

export type WebRoute = {
  prefix: string
  host: string
  port: number
  uid: number
}

export type ServiceHealth = {
  alive: boolean
  host: string
  port: number
  webctlPath: string
}

export function createWebRouteApi(baseUrl: string, fetchFn: typeof fetch) {
  const base = `${baseUrl}/api/v2/web-route`

  async function json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Web Route API ${res.status}: ${text}`)
    }
    return res.json() as Promise<T>
  }

  return {
    async list(): Promise<WebRoute[]> {
      const res = await fetchFn(base)
      const data = await json<{ ok: boolean; routes: WebRoute[] }>(res)
      return data.routes
    },

    async publish(prefix: string, port: number, host = "127.0.0.1"): Promise<{ ok: boolean; error?: string }> {
      const res = await fetchFn(`${base}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, host, port }),
      })
      return json(res)
    },

    async remove(prefix: string): Promise<{ ok: boolean; error?: string }> {
      const res = await fetchFn(`${base}/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix }),
      })
      return json(res)
    },

    async health(): Promise<Record<string, ServiceHealth>> {
      const res = await fetchFn(`${base}/health`)
      const data = await json<{ ok: boolean; status: Record<string, ServiceHealth> }>(res)
      return data.status
    },

    async toggle(entryName: string, action: "start" | "stop"): Promise<{ ok: boolean; output?: string; error?: string }> {
      const res = await fetchFn(`${base}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryName, action }),
      })
      return json(res)
    },
  }
}
