import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { RestartHandover } from "./restart-handover"

export namespace DaemonStartupLog {
  export type Input = {
    port?: number
    hostname?: string
    socketPath?: string
  }

  export type PendingRestart = {
    schemaVersion: 1
    txid: string
    checkpointPath: string
    createdAt: string
    status: string
  }

  export type Record = {
    schemaVersion: 1
    event: "daemon-started"
    createdAt: string
    pid: number
    ppid: number
    uid?: number
    cwd: string
    argv: string[]
    launchMode?: string
    userDaemonMode: boolean
    restartTxid?: string
    restartCheckpointPath?: string
    restartRequestedAt?: string
    port?: number
    hostname?: string
    socketPath?: string
  }

  export function dir() {
    return path.join(Global.Path.state, "daemon-startup")
  }

  export function logPath() {
    return path.join(dir(), "startup.jsonl")
  }

  export function pendingRestartPath() {
    return path.join(Global.Path.state, "restart-handover", "pending.json")
  }

  async function readPendingRestart() {
    const raw = await fs.readFile(pendingRestartPath(), "utf8").catch(() => undefined)
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw) as Partial<PendingRestart>
      if (parsed.schemaVersion !== 1 || typeof parsed.txid !== "string") return undefined
      if (parsed.status !== "restart-requested" && parsed.status !== "webctl-restart-requested") return undefined
      return parsed as PendingRestart
    } catch {
      return undefined
    }
  }

  export async function build(input: Input = {}): Promise<Record> {
    const pending = await readPendingRestart()
    return {
      schemaVersion: 1,
      event: "daemon-started",
      createdAt: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      cwd: process.cwd(),
      argv: process.argv.slice(),
      launchMode: process.env.OPENCODE_LAUNCH_MODE,
      userDaemonMode: process.env.OPENCODE_USER_DAEMON_MODE === "1",
      restartTxid: pending?.txid,
      restartCheckpointPath: pending?.checkpointPath,
      restartRequestedAt: pending?.createdAt,
      port: input.port,
      hostname: input.hostname,
      socketPath: input.socketPath,
    }
  }

  export async function record(input: Input = {}) {
    const pending = await readPendingRestart()
    const event = await build(input)
    await fs.mkdir(dir(), { recursive: true })
    await fs.appendFile(logPath(), JSON.stringify(event) + "\n", { mode: 0o600 })
    if (pending) {
      await RestartHandover.complete({
        txid: pending.txid,
        checkpointPath: pending.checkpointPath,
        startupLogPath: logPath(),
        pid: event.pid,
        ppid: event.ppid,
        socketPath: event.socketPath,
        port: event.port,
        hostname: event.hostname,
        buildId: Installation.BUILD_ID,
      })
    }
    return { path: logPath(), event }
  }
}
