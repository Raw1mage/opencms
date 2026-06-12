import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"

export namespace RestartHandover {
  export type Status = "restart-requested" | "restart-completed" | "restart-failed"

  export type BuildIdCheck = "match" | "mismatch" | "skipped-legacy"

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
    // Build-ID handshake (plans/infra_build-id-handshake DD-6): webctl injects
    // expectedBuildId (from dist/.build-id) after a verified build; the new
    // daemon compares its compiled BUILD_ID on completion.
    expectedBuildId?: string
    buildIdCheck?: BuildIdCheck
    failureReason?: string
    validationNextSteps: string[]
    completedAt?: string
    completedBy?: {
      pid: number
      ppid: number
      socketPath?: string
      port?: number
      hostname?: string
      startupLogPath: string
    }
  }

  export type CompletionInput = {
    txid: string
    checkpointPath: string
    startupLogPath: string
    pid: number
    ppid: number
    socketPath?: string
    port?: number
    hostname?: string
    // The BUILD_ID compiled into the daemon completing the handover (DD-6).
    // Injectable for tests; callers pass Installation.BUILD_ID.
    buildId?: string
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

  export async function complete(input: CompletionInput) {
    const completedAt = new Date().toISOString()
    const checkpointRaw = await fs.readFile(input.checkpointPath, "utf8")
    const checkpoint = JSON.parse(checkpointRaw) as Checkpoint
    if (checkpoint.txid !== input.txid) {
      throw new Error(`restart checkpoint txid mismatch: expected ${input.txid}, got ${checkpoint.txid}`)
    }

    // Build-ID handshake (DD-6): when webctl recorded an expectedBuildId, the
    // daemon completing the handover must be the binary that build produced.
    // A mismatch marks the restart as failed — no rollback, no fallback; the
    // failure is recorded as evidence for the operator.
    let buildIdCheck: BuildIdCheck = "skipped-legacy"
    let status: Status = "restart-completed"
    let failureReason: string | undefined
    if (checkpoint.expectedBuildId) {
      if (input.buildId && input.buildId !== "local" && input.buildId === checkpoint.expectedBuildId) {
        buildIdCheck = "match"
      } else {
        buildIdCheck = "mismatch"
        status = "restart-failed"
        failureReason = `build-id mismatch: expected ${checkpoint.expectedBuildId}, daemon reports ${input.buildId ?? "(none)"}`
      }
    }

    const completed: Checkpoint = {
      ...checkpoint,
      status,
      buildIdCheck,
      failureReason,
      completedAt,
      completedBy: {
        pid: input.pid,
        ppid: input.ppid,
        socketPath: input.socketPath,
        port: input.port,
        hostname: input.hostname,
        startupLogPath: input.startupLogPath,
      },
    }
    const checkpointTmp = `${input.checkpointPath}.tmp-${process.pid}`
    await fs.writeFile(checkpointTmp, JSON.stringify(completed, null, 2) + "\n", { mode: 0o600 })
    await fs.rename(checkpointTmp, input.checkpointPath)

    const pending = pendingPath()
    const pendingTmp = `${pending}.tmp-${process.pid}`
    await fs.writeFile(
      pendingTmp,
      JSON.stringify(
        {
          schemaVersion: 1,
          txid: input.txid,
          checkpointPath: input.checkpointPath,
          createdAt: checkpoint.createdAt,
          status: completed.status,
          completedAt,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    )
    await fs.rename(pendingTmp, pending)
    return completed
  }
}
