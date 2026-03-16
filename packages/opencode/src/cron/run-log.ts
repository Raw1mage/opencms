import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Lock } from "../util/lock"
import { Log } from "../util/log"
import { type CronRunLogEntry } from "./types"

/**
 * Run-log JSONL — append-only log of cron run outcomes (D.1.7).
 *
 * Each job gets its own JSONL file at:
 *   ~/.config/opencode/cron/runs/<jobId>.jsonl
 *
 * Auto-pruned on append when exceeding size/line limits.
 *
 * IDEF0 reference: A14 (Enforce Session Retention Policy)
 * Design decision: DD-8 (cron store path)
 */
export namespace RunLog {
  const log = Log.create({ service: "cron.runlog" })

  const MAX_SIZE_BYTES = 2 * 1024 * 1024 // 2 MB
  const MAX_LINES = 2000

  function runsDir(): string {
    return path.join(Global.Path.config, "cron", "runs")
  }

  function logPath(jobId: string): string {
    return path.join(runsDir(), `${jobId}.jsonl`)
  }

  function lockKey(jobId: string): string {
    return `cron:runlog:${jobId}`
  }

  export async function append(entry: CronRunLogEntry): Promise<void> {
    using _lock = await Lock.write(lockKey(entry.jobId))
    const dir = runsDir()
    await fs.mkdir(dir, { recursive: true })

    const filePath = logPath(entry.jobId)
    const line = JSON.stringify(entry) + "\n"
    await fs.appendFile(filePath, line)

    // Check if pruning needed
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > MAX_SIZE_BYTES) {
        await prune(filePath)
      }
    } catch {
      // stat failed — file might have just been created
    }

    log.info("appended", { jobId: entry.jobId, runId: entry.runId })
  }

  export async function read(jobId: string, limit?: number): Promise<CronRunLogEntry[]> {
    using _lock = await Lock.read(lockKey(jobId))
    try {
      const raw = await fs.readFile(logPath(jobId), "utf-8")
      const lines = raw.trim().split("\n").filter(Boolean)
      const entries = lines
        .map((line) => {
          try {
            return JSON.parse(line) as CronRunLogEntry
          } catch {
            return null
          }
        })
        .filter((e): e is CronRunLogEntry => e !== null)

      if (limit && entries.length > limit) {
        return entries.slice(-limit)
      }
      return entries
    } catch {
      return []
    }
  }

  export async function removeForJob(jobId: string): Promise<void> {
    using _lock = await Lock.write(lockKey(jobId))
    try {
      await fs.unlink(logPath(jobId))
      log.info("removed", { jobId })
    } catch {
      // File might not exist
    }
  }

  async function prune(filePath: string): Promise<void> {
    try {
      const raw = await fs.readFile(filePath, "utf-8")
      const lines = raw.trim().split("\n").filter(Boolean)

      if (lines.length <= MAX_LINES) return

      // Keep the most recent MAX_LINES entries
      const kept = lines.slice(-MAX_LINES)
      await fs.writeFile(filePath, kept.join("\n") + "\n")
      log.info("pruned", {
        filePath,
        before: lines.length,
        after: kept.length,
      })
    } catch (e) {
      log.error("prune failed", { filePath, error: e })
    }
  }

  /**
   * Force-prune a job's run log. Used by retention reaper.
   */
  export async function pruneForJob(jobId: string): Promise<void> {
    using _lock = await Lock.write(lockKey(jobId))
    const filePath = logPath(jobId)
    await prune(filePath)
  }
}
