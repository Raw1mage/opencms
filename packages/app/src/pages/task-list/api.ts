/**
 * Cron task API client — lightweight fetch wrapper over /api/v2/cron endpoints.
 * Uses the globalSDK.fetch for auth; does NOT modify the auto-generated SDK.
 */

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | { kind: "agentTurn"; message: string; model?: string; accountId?: string; timeoutSeconds?: number; lightContext?: boolean }

export type CronDelivery = {
  mode: "none" | "announce" | "webhook"
  webhookUrl?: string
  webhookBearerToken?: string
  announceSessionID?: string
  bestEffort?: boolean
}

export type CronJobState = {
  nextRunAtMs?: number
  runningAtMs?: number
  lastRunAtMs?: number
  lastRunStatus?: "ok" | "error" | "skipped"
  lastError?: string
  lastDurationMs?: number
  consecutiveErrors?: number
}

export type CronJob = {
  id: string
  name: string
  description?: string
  enabled: boolean
  deleteAfterRun?: boolean
  createdAtMs: number
  updatedAtMs: number
  schedule: CronSchedule
  sessionTarget: "main" | "isolated"
  wakeMode: "next-heartbeat" | "now"
  payload: CronPayload
  delivery?: CronDelivery
  state: CronJobState
}

export type CronRunLogEntry = {
  jobId: string
  runId: string
  startedAtMs: number
  completedAtMs?: number
  status?: "ok" | "error" | "skipped"
  error?: string
  summary?: string
  sessionId?: string
  durationMs?: number
}

export type CronJobCreateInput = {
  name: string
  description?: string
  enabled?: boolean
  schedule: CronSchedule
  payload: CronPayload
  delivery?: CronDelivery
  sessionTarget?: "main" | "isolated"
  wakeMode?: "next-heartbeat" | "now"
}

export type CronJobPatchInput = {
  name?: string
  description?: string
  enabled?: boolean
  schedule?: CronSchedule
  payload?: CronPayload
  delivery?: CronDelivery
  sessionTarget?: "main" | "isolated"
  wakeMode?: "next-heartbeat" | "now"
}

export type SessionMessage = {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  modelID?: string
  providerId?: string
  parentID?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number }
}

export type SessionTextPart = {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
}

export type SessionMessageWithParts = SessionMessage & {
  parts: SessionTextPart[]
}

export function createCronApi(baseUrl: string, fetchFn: typeof fetch) {
  const base = `${baseUrl}/api/v2/cron`
  const sessionBase = `${baseUrl}/api/v2/session`

  async function json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Cron API ${res.status}: ${text}`)
    }
    return res.json() as Promise<T>
  }

  return {
    async listJobs(): Promise<CronJob[]> {
      const res = await fetchFn(`${base}/jobs`)
      return json<CronJob[]>(res)
    },

    async getJob(id: string): Promise<CronJob> {
      const res = await fetchFn(`${base}/jobs/${encodeURIComponent(id)}`)
      return json<CronJob>(res)
    },

    async createJob(input: CronJobCreateInput): Promise<CronJob> {
      const res = await fetchFn(`${base}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      return json<CronJob>(res)
    },

    async updateJob(id: string, patch: CronJobPatchInput): Promise<CronJob> {
      const res = await fetchFn(`${base}/jobs/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })
      return json<CronJob>(res)
    },

    async deleteJob(id: string): Promise<void> {
      const res = await fetchFn(`${base}/jobs/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(`Cron API ${res.status}: ${text}`)
      }
    },

    async getRuns(id: string, limit = 20): Promise<CronRunLogEntry[]> {
      const res = await fetchFn(`${base}/jobs/${encodeURIComponent(id)}/runs?limit=${limit}`)
      return json<CronRunLogEntry[]>(res)
    },

    async triggerJob(id: string): Promise<void> {
      const res = await fetchFn(`${base}/jobs/${encodeURIComponent(id)}/run`, {
        method: "POST",
      })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(`Cron API ${res.status}: ${text}`)
      }
    },

    async getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
      const res = await fetchFn(`${sessionBase}/${encodeURIComponent(sessionId)}/message`)
      return json<SessionMessage[]>(res)
    },

    async getSessionMessage(sessionId: string, messageId: string): Promise<SessionMessageWithParts> {
      const res = await fetchFn(`${sessionBase}/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`)
      return json<SessionMessageWithParts>(res)
    },
  }
}
