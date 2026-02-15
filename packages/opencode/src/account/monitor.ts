import { Global } from "../global"
import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { Log } from "../util/log"

const log = Log.create({ service: "request-monitor" })

/**
 * Get the start of the current quota day (16:00 Asia/Taipei = 08:00 UTC).
 * RPD limits reset at this exact time.
 */
function getQuotaDayStart(): number {
  const now = new Date()
  const resetHourUTC = 8 // 16:00 Taipei is 08:00 UTC
  const todayReset = new Date(now)
  todayReset.setUTCHours(resetHourUTC, 0, 0, 0)

  if (now.getTime() < todayReset.getTime()) {
    // Before 16:00 today, the "day" started at 16:00 yesterday
    const yesterdayReset = new Date(todayReset)
    yesterdayReset.setUTCDate(yesterdayReset.getUTCDate() - 1)
    return yesterdayReset.getTime()
  }
  return todayReset.getTime()
}

type DailyStats = {
  lastReset: number // Timestamp of the 16:00 Taipei reset
  requests: number
  tokens: number
}

type WindowEntry = {
  ts: number
  tokens: number
}

type UsageEntry = {
  window: WindowEntry[] // Sliding window (last 60s)
  daily: DailyStats
}

type Storage = Record<string, DailyStats> // Only persist daily stats

type UsageStats = {
  rpm: number
  tpm: number
  rpd: number
  tpd: number
}

type ModelLimits = {
  rpm: number
  tpm: number
  rpd: number
}

const DEFAULT_LIMITS: ModelLimits = {
  rpm: 10,
  tpm: 1000000,
  rpd: 1000,
}

// Known Google Gemini API limits (Free Tier)
// Values based on official documentation and observations
const GEMINI_LIMITS: Record<string, ModelLimits> = {
  "gemini-3-pro": { rpm: 2, tpm: 32000, rpd: 250 },
  "gemini-2.5-pro": { rpm: 2, tpm: 32000, rpd: 1000 },
  "gemini-2.0-pro-exp-02-05": { rpm: 2, tpm: 32000, rpd: 50 },
  "gemini-2.5-flash": { rpm: 15, tpm: 1000000, rpd: 10000 },
  "gemini-1.5-pro": { rpm: 2, tpm: 32000, rpd: 50 },
  "gemini-1.5-flash": { rpm: 15, tpm: 1000000, rpd: 1500 },
  "gemini-2.0-flash-exp": { rpm: 10, tpm: 4000000, rpd: 1500 },
  "gemini-3-flash": { rpm: 15, tpm: 1000000, rpd: 10000 },
}

export class RequestMonitor {
  private static instance: RequestMonitor
  private memory: Record<string, UsageEntry> = {}
  private filePath: string
  private loaded = false
  private saveTimeout: ReturnType<typeof setTimeout> | null = null

  private constructor() {
    // Determine path
    this.filePath = path.join(Global.Path.config, "usage-stats.json")
    this.load().catch(() => {})
  }

  static get(): RequestMonitor {
    if (!this.instance) {
      this.instance = new RequestMonitor()
    }
    return this.instance
  }

  public getModelLimits(providerId: string, modelId: string): ModelLimits {
    if (providerId === "gemini-cli" || providerId === "google-api") {
      // Normalize model ID (remove models/ prefix if present)
      const id = modelId.replace(/^models\//, "")

      // Exact match
      if (GEMINI_LIMITS[id]) return GEMINI_LIMITS[id]

      // Partial match (longest key first)
      const keys = Object.keys(GEMINI_LIMITS).sort((a, b) => b.length - a.length)
      for (const key of keys) {
        if (id.includes(key)) {
          return GEMINI_LIMITS[key]
        }
      }
    }
    return DEFAULT_LIMITS
  }

  private getKey(providerId: string, accountId: string, modelId: string): string {
    return `${providerId}:${accountId}:${modelId}`
  }

  private async load() {
    if (this.loaded) return
    try {
      if (existsSync(this.filePath)) {
        const content = await fs.readFile(this.filePath, "utf-8")
        const data = JSON.parse(content) as Storage

        for (const [key, daily] of Object.entries(data)) {
          if (!this.memory[key]) {
            this.memory[key] = {
              window: [],
              daily,
            }
          } else {
            // Merge if resets match
            if (this.memory[key].daily.lastReset === daily.lastReset) {
              this.memory[key].daily.requests += daily.requests
              this.memory[key].daily.tokens += daily.tokens
            }
          }
        }
      }
    } catch (e) {
      log.warn("Failed to load usage stats", { error: e })
    } finally {
      this.loaded = true
    }
  }

  private async save() {
    try {
      const toSave: Storage = {}
      for (const [key, entry] of Object.entries(this.memory)) {
        toSave[key] = entry.daily
      }
      await fs.writeFile(this.filePath, JSON.stringify(toSave, null, 2))
    } catch (e) {
      log.error("Failed to save usage stats", { error: e })
    }
  }

  public recordRequest(providerId: string, accountId: string, modelId: string, tokens: number = 0) {
    const key = this.getKey(providerId, accountId, modelId)
    const now = Date.now()
    const quotaDayStart = getQuotaDayStart()

    if (!this.memory[key]) {
      this.memory[key] = {
        window: [],
        daily: { lastReset: quotaDayStart, requests: 0, tokens: 0 },
      }
    }

    const entry = this.memory[key]

    // Check daily reset
    if (entry.daily.lastReset < quotaDayStart) {
      entry.daily = { lastReset: quotaDayStart, requests: 0, tokens: 0 }
    }

    // Add to window
    entry.window.push({ ts: now, tokens })

    // Update daily
    entry.daily.requests++
    entry.daily.tokens += tokens

    // Prune window immediately to keep memory low
    this.prune(entry.window, now)

    this.save()
  }

  public async sync() {
    try {
      if (existsSync(this.filePath)) {
        const content = await fs.readFile(this.filePath, "utf-8")
        const data = JSON.parse(content) as Storage

        for (const [key, daily] of Object.entries(data)) {
          if (!this.memory[key]) {
            this.memory[key] = {
              window: [],
              daily,
            }
          } else {
            this.memory[key].daily = daily
          }
        }
      }
    } catch (e) {
      log.warn("Failed to sync usage stats", { error: e })
    }
  }

  private prune(window: WindowEntry[], now: number) {
    const limit = now - 60 * 1000
    while (window.length > 0 && window[0].ts < limit) {
      window.shift()
    }
  }

  public getStats(providerId: string, accountId: string, modelId: string): UsageStats {
    const key = this.getKey(providerId, accountId, modelId)
    const entry = this.memory[key]

    if (!entry) return { rpm: 0, tpm: 0, rpd: 0, tpd: 0 }

    const now = Date.now()
    this.prune(entry.window, now)

    const rpm = entry.window.length
    const tpm = entry.window.reduce((sum, item) => sum + item.tokens, 0)

    // Check if daily is stale
    const quotaDayStart = getQuotaDayStart()
    if (entry.daily.lastReset < quotaDayStart) {
      return { rpm, tpm, rpd: 0, tpd: 0 }
    }

    return {
      rpm,
      tpm,
      rpd: entry.daily.requests,
      tpd: entry.daily.tokens,
    }
  }

  /**
   * Determine current status of a 3D vector based on stats vs constant limits.
   */
  public getStatus(
    providerId: string,
    accountId: string,
    modelId: string,
  ): { status: "healthy" | "rpm" | "rpd"; message: string } {
    const stats = this.getStats(providerId, accountId, modelId)
    const limits = this.getModelLimits(providerId, modelId)

    if (stats.rpd >= limits.rpd) {
      return { status: "rpd", message: `RPD Limit Hit (${stats.rpd}/${limits.rpd})` }
    }

    if (stats.rpm >= limits.rpm) {
      return { status: "rpm", message: `RPM Limit Hit (${stats.rpm}/${limits.rpm})` }
    }

    return { status: "healthy", message: `Healthy (${stats.rpd}/${limits.rpd} req/day)` }
  }
}
