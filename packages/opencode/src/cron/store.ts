import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Lock } from "../util/lock"
import { Log } from "../util/log"
import {
  CronStoreFileSchema,
  type CronJob,
  type CronJobCreate,
  type CronJobPatch,
  type CronStoreFile,
} from "./types"

/**
 * Cron job store — persists jobs at ~/.config/opencode/cron/jobs.json
 *
 * IDEF0 reference: A11 (Scope Session Key Namespace) + A14 (Enforce Session Retention Policy)
 * Design decision: DD-8 (cron store path)
 */
export namespace CronStore {
  const log = Log.create({ service: "cron.store" })
  const LOCK_KEY = "cron:store"

  function storeDir(): string {
    return path.join(Global.Path.config, "cron")
  }

  function storePath(): string {
    return path.join(storeDir(), "jobs.json")
  }

  async function readFile(): Promise<CronStoreFile> {
    try {
      const raw = await Bun.file(storePath()).text()
      const parsed = JSON.parse(raw)
      return CronStoreFileSchema.parse(parsed)
    } catch {
      return { version: 1, jobs: [] }
    }
  }

  async function writeFile(data: CronStoreFile): Promise<void> {
    await fs.mkdir(storeDir(), { recursive: true })
    await Bun.write(storePath(), JSON.stringify(data, null, 2))
  }

  export async function list(): Promise<CronJob[]> {
    using _lock = await Lock.read(LOCK_KEY)
    const store = await readFile()
    return store.jobs
  }

  export async function get(jobId: string): Promise<CronJob | undefined> {
    using _lock = await Lock.read(LOCK_KEY)
    const store = await readFile()
    return store.jobs.find((j) => j.id === jobId)
  }

  export async function create(input: CronJobCreate): Promise<CronJob> {
    using _lock = await Lock.write(LOCK_KEY)
    const store = await readFile()
    const now = Date.now()
    const job: CronJob = {
      ...input,
      id: crypto.randomUUID(),
      createdAtMs: now,
      updatedAtMs: now,
      state: input.state
        ? {
            consecutiveErrors: 0,
            ...input.state,
          }
        : {
            consecutiveErrors: 0,
          },
    }
    store.jobs.push(job)
    await writeFile(store)
    log.info("created", { id: job.id, name: job.name })
    return job
  }

  export async function update(jobId: string, patch: CronJobPatch): Promise<CronJob | undefined> {
    using _lock = await Lock.write(LOCK_KEY)
    const store = await readFile()
    const idx = store.jobs.findIndex((j) => j.id === jobId)
    if (idx === -1) return undefined

    const existing = store.jobs[idx]
    const updated: CronJob = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAtMs: existing.createdAtMs,
      updatedAtMs: Date.now(),
      state: {
        ...existing.state,
        ...patch.state,
      },
    }
    store.jobs[idx] = updated
    await writeFile(store)
    log.info("updated", { id: jobId })
    return updated
  }

  export async function updateState(
    jobId: string,
    statePatch: Partial<CronJob["state"]>,
  ): Promise<CronJob | undefined> {
    return update(jobId, { state: statePatch })
  }

  export async function remove(jobId: string): Promise<boolean> {
    using _lock = await Lock.write(LOCK_KEY)
    const store = await readFile()
    const before = store.jobs.length
    store.jobs = store.jobs.filter((j) => j.id !== jobId)
    if (store.jobs.length === before) return false
    await writeFile(store)
    log.info("removed", { id: jobId })
    return true
  }

  export async function listEnabled(): Promise<CronJob[]> {
    const jobs = await list()
    return jobs.filter((j) => j.enabled)
  }
}
