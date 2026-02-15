import { Global } from "../global"
import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { Log } from "../util/log"

const log = Log.create({ service: "request-monitor" })

type DailyStats = {
  date: string
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
            // Merge if dates match
            if (this.memory[key].daily.date === daily.date) {
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
    const today = new Date().toISOString().split("T")[0]

    if (!this.memory[key]) {
      this.memory[key] = {
        window: [],
        daily: { date: today, requests: 0, tokens: 0 },
      }
    }

    const entry = this.memory[key]

    // Check daily reset
    if (entry.daily.date !== today) {
      entry.daily = { date: today, requests: 0, tokens: 0 }
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

  public getStats(providerId: string, accountId: string, modelId: string) {
    const key = this.getKey(providerId, accountId, modelId)
    const entry = this.memory[key]

    if (!entry) return { rpm: 0, tpm: 0, rpd: 0, tpd: 0 }

    const now = Date.now()
    this.prune(entry.window, now)

    const rpm = entry.window.length
    const tpm = entry.window.reduce((sum, item) => sum + item.tokens, 0)

    // Check if daily is stale (e.g. valid entry but date changed since last record)
    const today = new Date().toISOString().split("T")[0]
    if (entry.daily.date !== today) {
      return { rpm, tpm, rpd: 0, tpd: 0 }
    }

    return {
      rpm,
      tpm,
      rpd: entry.daily.requests,
      tpd: entry.daily.tokens,
    }
  }
}
