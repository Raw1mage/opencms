import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"

export namespace RestartHandover {
  export type Status = "restart-requested"

  export type Input = {
    txid: string
    runtimeMode: string
    targets: string[]
    reason?: string
    sessionID?: string
    handover?: string
    errorLogPath?: string
    webctlPath?: string
  }

  export type Checkpoint = {
    schemaVersion: 1
    checkpointID: string
    txid: string
    status: Status
    createdAt: string
    pid: number
    runtimeMode: string
    targets: string[]
    reason?: string
    sessionID?: string
    handover?: string
    errorLogPath?: string
    webctlPath?: string
    validationNextSteps: string[]
  }

  export function dir() {
    return path.join(Global.Path.state, "restart-handover")
  }

  export function filePath(txid: string) {
    const safe = txid.replace(/[^a-zA-Z0-9_.-]/g, "-")
    return path.join(dir(), `${safe}.json`)
  }

  export function pendingPath() {
    return path.join(dir(), "pending.json")
  }

  function redactedText(value: string | undefined, maxLength: number) {
    if (!value) return undefined
    return value.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=<redacted>").slice(0, maxLength)
  }

  export function build(input: Input): Checkpoint {
    return {
      schemaVersion: 1,
      checkpointID: input.txid,
      txid: input.txid,
      status: "restart-requested",
      createdAt: new Date().toISOString(),
      pid: process.pid,
      runtimeMode: input.runtimeMode,
      targets: input.targets,
      reason: redactedText(input.reason, 500),
      sessionID: input.sessionID,
      handover: redactedText(input.handover, 4000),
      errorLogPath: input.errorLogPath,
      webctlPath: input.webctlPath,
      validationNextSteps: [
        "After reconnect, do not infer restart success from a closed socket.",
        "Probe /api/v2/global/health and inspect the restart txid/error log if available.",
        "Resume the recorded session/plan context before issuing follow-up restart claims.",
      ],
    }
  }

  export async function write(input: Input) {
    const checkpoint = build(input)
    const target = filePath(input.txid)
    const tmp = `${target}.tmp-${process.pid}`
    const pending = pendingPath()
    const pendingTmp = `${pending}.tmp-${process.pid}`
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(checkpoint, null, 2) + "\n", { mode: 0o600 })
    await fs.rename(tmp, target)
    await fs.writeFile(
      pendingTmp,
      JSON.stringify(
        {
          schemaVersion: 1,
          txid: input.txid,
          checkpointPath: target,
          createdAt: checkpoint.createdAt,
          status: checkpoint.status,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    )
    await fs.rename(pendingTmp, pending)
    return { path: target, checkpoint }
  }
}
