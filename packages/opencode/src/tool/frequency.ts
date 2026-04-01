import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.frequency" })
const MS_PER_DAY = 86_400_000

export namespace ToolFrequency {
  export interface Entry {
    tool: string
    count: number
    lastUsed: number
    heatScore: number
  }

  export interface Store {
    version: 1
    entries: Record<string, Entry>
    updatedAt: number
  }

  function filePath() {
    return path.join(Global.Path.state, "tool-frequency.json")
  }

  function computeHeatScore(count: number, lastUsed: number, now: number): number {
    const daysSince = (now - lastUsed) / MS_PER_DAY
    return count * (1 / (1 + daysSince))
  }

  function recalculate(store: Store): Store {
    const now = Date.now()
    for (const entry of Object.values(store.entries)) {
      entry.heatScore = computeHeatScore(entry.count, entry.lastUsed, now)
    }
    store.updatedAt = now
    return store
  }

  function empty(): Store {
    return { version: 1, entries: {}, updatedAt: Date.now() }
  }

  export async function load(): Promise<Store> {
    try {
      const file = Bun.file(filePath())
      if (!(await file.exists())) return empty()
      const raw = await file.json()
      if (raw?.version !== 1) {
        log.warn("tool-frequency.json version mismatch, resetting", { found: raw?.version })
        return empty()
      }
      return recalculate(raw as Store)
    } catch (err) {
      log.warn("failed to load tool-frequency.json, starting fresh", { error: err })
      return empty()
    }
  }

  export async function save(store: Store): Promise<void> {
    const tmp = filePath() + ".tmp"
    await Bun.write(tmp, JSON.stringify(store, null, 2))
    const fs = await import("fs/promises")
    await fs.rename(tmp, filePath())
  }

  export async function record(toolID: string): Promise<void> {
    const store = await load()
    const now = Date.now()
    const existing = store.entries[toolID]
    if (existing) {
      existing.count++
      existing.lastUsed = now
      existing.heatScore = computeHeatScore(existing.count, existing.lastUsed, now)
    } else {
      store.entries[toolID] = {
        tool: toolID,
        count: 1,
        lastUsed: now,
        heatScore: computeHeatScore(1, now, now),
      }
    }
    store.updatedAt = now
    await save(store)
  }

  export async function scores(): Promise<Record<string, number>> {
    const store = await load()
    return Object.fromEntries(Object.entries(store.entries).map(([id, entry]) => [id, entry.heatScore]))
  }

  export async function promoted(threshold: number): Promise<string[]> {
    const store = await load()
    return Object.values(store.entries)
      .filter((entry) => entry.heatScore >= threshold)
      .sort((a, b) => b.heatScore - a.heatScore)
      .map((entry) => entry.tool)
  }
}
