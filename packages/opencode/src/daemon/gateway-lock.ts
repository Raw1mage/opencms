import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Log } from "../util/log"

/**
 * Gateway lock — file-based singleton to ensure only one daemon instance (D.3.1).
 *
 * Uses a PID lock file at ~/.config/opencode/daemon.lock.
 * On acquire: writes current PID. On release: removes file.
 * Stale locks (PID no longer running) are automatically broken.
 *
 * IDEF0 reference: A31 (Acquire Gateway Lock)
 * GRAFCET reference: opencode_a3_grafcet.json step S0
 */
export namespace GatewayLock {
  const log = Log.create({ service: "daemon.lock" })

  function lockPath(): string {
    return path.join(Global.Path.config, "daemon.lock")
  }

  export type LockInfo = {
    pid: number
    acquiredAtMs: number
  }

  /**
   * Attempt to acquire the gateway lock.
   * Returns true if lock was acquired, false if another instance holds it.
   */
  export async function acquire(): Promise<boolean> {
    const filePath = lockPath()

    // Check for existing lock
    const existing = await readLock()
    if (existing) {
      if (isProcessRunning(existing.pid)) {
        log.warn("lock held by another process", { pid: existing.pid })
        return false
      }
      // Stale lock — break it
      log.info("breaking stale lock", { pid: existing.pid })
    }

    // Write our PID
    const info: LockInfo = {
      pid: process.pid,
      acquiredAtMs: Date.now(),
    }
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(info, null, 2))
      log.info("acquired", { pid: process.pid })
      return true
    } catch (e) {
      log.error("acquire failed", { error: e })
      return false
    }
  }

  /**
   * Release the gateway lock.
   * Only removes the lock if it's held by the current process.
   */
  export async function release(): Promise<void> {
    const existing = await readLock()
    if (!existing || existing.pid !== process.pid) {
      log.warn("release skipped — not lock holder", {
        currentPid: process.pid,
        lockPid: existing?.pid,
      })
      return
    }

    try {
      await fs.unlink(lockPath())
      log.info("released", { pid: process.pid })
    } catch {
      // File might already be gone
    }
  }

  /**
   * Check if the gateway lock is currently held.
   */
  export async function isHeld(): Promise<boolean> {
    const existing = await readLock()
    if (!existing) return false
    return isProcessRunning(existing.pid)
  }

  /**
   * Read the current lock holder info.
   */
  export async function holder(): Promise<LockInfo | undefined> {
    const existing = await readLock()
    if (!existing) return undefined
    if (!isProcessRunning(existing.pid)) return undefined
    return existing
  }

  async function readLock(): Promise<LockInfo | undefined> {
    try {
      const raw = await fs.readFile(lockPath(), "utf-8")
      return JSON.parse(raw) as LockInfo
    } catch {
      return undefined
    }
  }

  function isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}
