import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { Provider } from "../provider/provider"
import { Log } from "@/util/log"
import { debugCheckpoint } from "@/util/debug"
import { fileURLToPath } from "url"
import { ProcessSupervisor } from "@/process/supervisor"
import { SessionStatus } from "@/session/status"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { ActivityBeacon } from "@/util/activity-beacon"
import { BusEvent } from "@/bus/bus-event"
import { Lock } from "@/util/lock"
import { Global } from "@/global"
import path from "path"
// Note: orchestrateModelSelection no longer used — subagent validates model against registry directly

// NOTE: @event_task_tool_complex_input
// Updated schema to support both simple string and complex structured input.
// This allows passing additional metadata and task configuration alongside the prompt.
// The prompt can be:
// - A simple string: "Write unit tests for auth module"
// - A JSON object: { "type": "testing", "content": "...", "metadata": { "priority": "high" } }
const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  // Support both simple text and complex structured input
  prompt: z
    .union([
      z.string(),
      z.object({
        type: z
          .enum(["analysis", "implementation", "review", "testing", "documentation"])
          .describe("Task category type"),
        content: z.string().describe("Task content and requirements"),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional task metadata (priority, tags, etc.)"),
      }),
    ])
    .describe("The task for the agent to perform. Supports: simple string or JSON object with type/content/metadata"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  session_id: z.string().describe("Existing Task session to continue").optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  model: z.string().describe("Optional model override (must exist in user's available model list). Omit to inherit parent session model.").optional(),
  account_id: z.string().describe("Optional account ID to pin for this task model").optional(),
})

function normalizeTitleText(text: string) {
  return text
    .replace(/^#+\s*/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^user request:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
}

function extractPromptSummary(prompt: z.infer<typeof parameters>["prompt"]) {
  const raw = typeof prompt === "string" ? prompt : prompt.content
  const lines = raw
    .split("\n")
    .map((line) => normalizeTitleText(line))
    .filter(Boolean)
  const first = lines.find((line) => !/^objective|^context|^constraints|^requirements/i.test(line)) ?? lines[0] ?? ""
  const clipped = first.length > 72 ? first.slice(0, 69) + "..." : first
  return clipped
}

function createSubsessionTitle(params: z.infer<typeof parameters>, agentName: string) {
  const description = normalizeTitleText(params.description)
  const promptSummary = extractPromptSummary(params.prompt)
  const genericDescription = /^(auto\s+\w+\s+task|task|subtask|auto task)$/i.test(description)
  const base = !description || genericDescription || description.length < 8 ? promptSummary || description : description
  const withAgent = `${base || "Subtask"} (@${agentName})`
  return withAgent.length > 96 ? withAgent.slice(0, 93) + "..." : withAgent
}

function toolWhitelistForSubagent(agentName: string): string[] | undefined {
  const name = agentName.toLowerCase()
  if (name === "explore") {
    return ["read", "glob", "grep", "list", "bash", "webfetch", "websearch", "codesearch", "question", "skill"]
  }
  if (name === "review" || name === "testing") {
    return ["read", "glob", "grep", "list", "bash", "webfetch", "websearch", "codesearch", "question", "skill"]
  }
  if (name === "coding") {
    return ["read", "glob", "grep", "list", "bash", "edit", "write", "apply_patch", "question", "skill"]
  }
  return undefined
}

const BRIDGE_PREFIX = "__OPENCODE_BRIDGE_EVENT__ "
const WORKER_PREFIX = "__OPENCODE_WORKER__ "
const WORKER_READY_TIMEOUT_MS = 15_000
const WORKER_IDLE_TIMEOUT_MS = 60_000 // Kill idle workers after 60s
const WORKER_POOL_MAX = 3 // Hard cap on concurrent worker processes
const beacon = ActivityBeacon.scope("tool.task")
const WORKER_ASSIGN_LOCK = "tool.task.worker.assign"

export const TaskWorkerEvent = {
  Assigned: BusEvent.define(
    "task.worker.assigned",
    z.object({
      workerID: z.string(),
      sessionID: Identifier.schema("session"),
    }),
  ),
  Done: BusEvent.define(
    "task.worker.done",
    z.object({
      workerID: z.string(),
      sessionID: Identifier.schema("session"),
    }),
  ),
  Failed: BusEvent.define(
    "task.worker.failed",
    z.object({
      workerID: z.string(),
      sessionID: Identifier.schema("session"),
    }),
  ),
  Removed: BusEvent.define(
    "task.worker.removed",
    z.object({
      workerID: z.string(),
    }),
  ),
}

async function publishBridgedEvent(event: { type: string; properties: any }) {
  beacon.hit("bridge.publish")
  switch (event.type) {
    case MessageV2.Event.Updated.type:
      await Bus.publish(MessageV2.Event.Updated, event.properties)
      return
    case MessageV2.Event.Removed.type:
      await Bus.publish(MessageV2.Event.Removed, event.properties)
      return
    case MessageV2.Event.PartUpdated.type:
      await Bus.publish(MessageV2.Event.PartUpdated, event.properties)
      return
    case MessageV2.Event.PartRemoved.type:
      await Bus.publish(MessageV2.Event.PartRemoved, event.properties)
      return
    case Session.Event.Updated.type:
      await Bus.publish(Session.Event.Updated, event.properties)
      return
    case Session.Event.Diff.type:
      await Bus.publish(Session.Event.Diff, event.properties)
      return
    case SessionStatus.Event.Status.type:
      await Bus.publish(SessionStatus.Event.Status, event.properties)
      return
    case Todo.Event.Updated.type:
      await Bus.publish(Todo.Event.Updated, event.properties)
      return
    case PermissionNext.Event.Asked.type:
      await Bus.publish(PermissionNext.Event.Asked, event.properties)
      return
    case PermissionNext.Event.Replied.type:
      await Bus.publish(PermissionNext.Event.Replied, event.properties)
      return
    case Question.Event.Asked.type:
      await Bus.publish(Question.Event.Asked, event.properties)
      return
    case Question.Event.Replied.type:
      await Bus.publish(Question.Event.Replied, event.properties)
      return
    case Question.Event.Rejected.type:
      await Bus.publish(Question.Event.Rejected, event.properties)
      return
  }
}

type WorkerRequest = {
  id: string
  sessionID: string
  createdAt: number
  dispatchedAt?: number
  firstEventAt?: number
  lastEventAt?: number
  eventCount: number
  resolve: (result: WorkerRunResult) => void
  reject: (error: Error) => void
}

type TaskWorker = {
  id: string
  proc: Bun.Subprocess
  busy: boolean
  ready: boolean
  readyPromise: Promise<void>
  readyResolve: () => void
  lastHeartbeatAt?: number
  lastPhase?: string
  lastWorkerMessage?: string
  lastStderr?: string
  current?: WorkerRequest
  idleTimer?: ReturnType<typeof setTimeout>
}

type WorkerRunResult = {
  workerID: string
  requestID: string
  sessionID: string
  createdAt: number
  dispatchedAt?: number
  firstEventAt?: number
  lastEventAt?: number
  eventCount: number
  doneAt: number
}

function extractEventSessionID(event: any): string | undefined {
  const properties = event?.properties
  if (!properties) return
  if (typeof properties.sessionID === "string") return properties.sessionID
  if (typeof properties.info?.sessionID === "string") return properties.info.sessionID
  if (typeof properties.part?.sessionID === "string") return properties.part.sessionID
  if (typeof properties.info?.id === "string" && event?.type?.startsWith("session.")) return properties.info.id
  return
}

const workers: TaskWorker[] = []
let workerSeq = 0
let standbySpawn: Promise<void> | undefined

function buildWorkerCmd() {
  const indexScript = fileURLToPath(new URL("../index.ts", import.meta.url))
  const isBun = /(^|\/)bun(\.exe)?$/.test(process.argv[0])
  return isBun ? [process.argv[0], "run", indexScript, "session", "worker"] : [process.argv[0], "session", "worker"]
}

function removeWorker(id: string) {
  const index = workers.findIndex((w) => w.id === id)
  if (index >= 0) {
    const w = workers[index]
    if (w.idleTimer) clearTimeout(w.idleTimer)
    workers.splice(index, 1)
  }
  beacon.setGauge("worker.total", workers.length)
  void Bus.publish(TaskWorkerEvent.Removed, { workerID: id })
}

function killIdleWorker(worker: TaskWorker) {
  if (worker.busy || worker.current) return // became busy in the meantime
  beacon.hit("worker.idle_reap")
  Log.create({ service: "task.worker" }).info("Reaping idle worker", { workerID: worker.id })
  ProcessSupervisor.kill(worker.id)
  removeWorker(worker.id)
  try {
    worker.proc.kill()
  } catch {
    // already dead
  }
}

function scheduleIdleReap(worker: TaskWorker) {
  if (worker.idleTimer) clearTimeout(worker.idleTimer)
  worker.idleTimer = setTimeout(() => killIdleWorker(worker), WORKER_IDLE_TIMEOUT_MS)
  if (typeof worker.idleTimer.unref === "function") worker.idleTimer.unref()
}

function cancelIdleReap(worker: TaskWorker) {
  if (worker.idleTimer) {
    clearTimeout(worker.idleTimer)
    worker.idleTimer = undefined
  }
}

function spawnWorker(config: Awaited<ReturnType<typeof Config.get>>) {
  beacon.hit("worker.spawn")
  const workerID = `task-worker-${++workerSeq}`
  const proc = Bun.spawn(buildWorkerCmd(), {
    env: {
      ...process.env,
      OPENCODE_NON_INTERACTIVE: "1",
      OPENCODE_TASK_EVENT_BRIDGE: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  let readyResolve = () => {}
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve
  })

  const worker: TaskWorker = {
    id: workerID,
    proc,
    busy: false,
    ready: false,
    readyPromise,
    readyResolve,
    lastPhase: "spawned",
  }
  workers.push(worker)
  beacon.setGauge("worker.total", workers.length)

  ProcessSupervisor.register({
    id: workerID,
    kind: "task-subagent",
    process: proc,
  })

  const log = Log.create({ service: "task.worker" })
  ;(async () => {
    const stderr = proc.stderr
    if (!stderr) return
    const reader = stderr.getReader()
    const decoder = new TextDecoder()
    let captured = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      captured = (captured + text).slice(-4000)
      worker.lastStderr = captured
      try {
        process.stderr.write(text)
      } catch {
        // ignore stderr forward failures
      }
    }
  })().catch(() => {
    // ignore stderr bridge failures
  })
  ;(async () => {
    const reader = proc.stdout?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buffer = ""
    let bridgedEvents = 0
    let bridgeParseErrors = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const newline = buffer.indexOf("\n")
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)

        if (line.startsWith(BRIDGE_PREFIX)) {
          beacon.hit("worker.bridge_line")
          const payload = line.slice(BRIDGE_PREFIX.length)
          try {
            const event = JSON.parse(payload)
            bridgedEvents += 1
            beacon.hit("worker.bridge_event")
            const sid = extractEventSessionID(event)
            if (worker.current && sid === worker.current.sessionID) {
              const now = Date.now()
              worker.current.eventCount += 1
              worker.current.lastEventAt = now
              if (!worker.current.firstEventAt) worker.current.firstEventAt = now
            }
            void publishBridgedEvent(event).catch(() => {})
          } catch {
            // ignore invalid bridge payload
            bridgeParseErrors += 1
            beacon.hit("worker.bridge_parse_error")
          }
          continue
        }

        if (!line.startsWith(WORKER_PREFIX)) continue
        const payload = line.slice(WORKER_PREFIX.length)
        let msg: any
        try {
          msg = JSON.parse(payload)
        } catch {
          continue
        }

        if (msg?.type === "ready") {
          beacon.hit("worker.ready")
          worker.ready = true
          worker.readyResolve()
          worker.lastHeartbeatAt = Date.now()
          worker.lastPhase = "ready"
          worker.lastWorkerMessage = "ready"
          if (!worker.busy) scheduleIdleReap(worker)
          continue
        }

        if (msg?.type === "heartbeat") {
          beacon.hit("worker.heartbeat")
          worker.lastHeartbeatAt = Date.now()
          worker.lastPhase = "heartbeat"
          worker.lastWorkerMessage = "heartbeat"
          continue
        }

        if (msg?.type === "done" && worker.current?.id === msg.id) {
          beacon.hit("worker.done")
          worker.lastPhase = "done"
          worker.lastWorkerMessage = typeof msg.error === "string" ? `done:${msg.error}` : "done"
          const req = worker.current
          worker.current = undefined
          worker.busy = false
          scheduleIdleReap(worker)
          if (!req) continue
          if (msg.ok) {
            req.resolve({
              workerID: worker.id,
              requestID: req.id,
              sessionID: req.sessionID,
              createdAt: req.createdAt,
              dispatchedAt: req.dispatchedAt,
              firstEventAt: req.firstEventAt,
              lastEventAt: req.lastEventAt,
              eventCount: req.eventCount,
              doneAt: Date.now(),
            })
            void Bus.publish(TaskWorkerEvent.Done, {
              workerID: worker.id,
              sessionID: req.sessionID,
            })
          } else {
            void Bus.publish(TaskWorkerEvent.Failed, {
              workerID: worker.id,
              sessionID: req.sessionID,
            })
            req.reject(new Error(msg.error || "worker run failed"))
          }
          void ensureStandbyWorker(config)
        }

        if (msg?.type === "canceled" && worker.current?.sessionID === msg.sessionID) {
          beacon.hit("worker.canceled")
          worker.lastPhase = "canceled"
          worker.lastWorkerMessage = `canceled:${msg.sessionID}`
          const req = worker.current
          worker.current = undefined
          worker.busy = false
          scheduleIdleReap(worker)
          if (!req) continue
          void Bus.publish(TaskWorkerEvent.Failed, {
            workerID: worker.id,
            sessionID: req.sessionID,
          })
          req.reject(new Error("worker run canceled"))
          void ensureStandbyWorker(config)
          continue
        }

        if (msg?.type === "error") {
          beacon.hit("worker.error")
          worker.lastPhase = "error"
          worker.lastWorkerMessage = typeof msg.error === "string" ? msg.error : "error"
          if (worker.current && msg.id === worker.current.id) {
            const req = worker.current
            worker.current = undefined
            worker.busy = false
            scheduleIdleReap(worker)
            void Bus.publish(TaskWorkerEvent.Failed, {
              workerID: worker.id,
              sessionID: req.sessionID,
            })
            req.reject(new Error(msg.error || "worker error"))
            void ensureStandbyWorker(config)
          }
          continue
        }
      }
    }

    if (!worker.ready) worker.readyResolve()
    const req = worker.current
    worker.current = undefined
    worker.busy = false
    removeWorker(worker.id)
    const exitCode = await proc.exited.catch(() => -1)
    const diagnostics = {
      workerID,
      exitCode,
      lastPhase: worker.lastPhase,
      lastWorkerMessage: worker.lastWorkerMessage,
      hasCurrentRequest: !!req,
      requestID: req?.id,
      sessionID: req?.sessionID,
      eventCount: req?.eventCount,
      firstEventAt: req?.firstEventAt,
      lastEventAt: req?.lastEventAt,
      lastHeartbeatAt: worker.lastHeartbeatAt,
      lastStderr: worker.lastStderr?.slice(-1000),
    }
    debugCheckpoint("task.worker", "worker_exit_unexpected", diagnostics)
    if (req) {
      const detail = [
        `exitCode=${exitCode}`,
        worker.lastPhase ? `lastPhase=${worker.lastPhase}` : undefined,
        worker.lastWorkerMessage ? `lastWorkerMessage=${worker.lastWorkerMessage}` : undefined,
        worker.lastStderr?.trim() ? `stderr=${worker.lastStderr.trim().slice(-300)}` : undefined,
      ]
        .filter(Boolean)
        .join(", ")
      req.reject(new Error(`worker process exited unexpectedly${detail ? ` (${detail})` : ""}`))
    }
    log.debug("task worker exited", diagnostics)
    log.debug("task worker bridge stats", { workerID, bridgedEvents, bridgeParseErrors })
  })().catch(() => {
    removeWorker(worker.id)
    if (!worker.ready) worker.readyResolve()
    if (worker.current) worker.current.reject(new Error("worker stream failed"))
  })

  return worker
}

async function getReadyWorker(config: Awaited<ReturnType<typeof Config.get>>) {
  beacon.hit("worker.get_ready")
  beacon.setGauge("worker.busy", workers.filter((w) => w.busy).length)
  beacon.setGauge("worker.ready", workers.filter((w) => w.ready).length)
  const log = Log.create({ service: "task.worker" })
  const idleReady = workers.find((w) => !w.busy && w.ready)
  if (idleReady) return idleReady

  const existing = workers.find((w) => !w.busy)
  if (existing) {
    await Promise.race([existing.readyPromise, Bun.sleep(WORKER_READY_TIMEOUT_MS)])
    if (existing.ready) return existing
    log.warn("existing worker not ready within timeout", { workerID: existing.id, timeoutMs: WORKER_READY_TIMEOUT_MS })
  }

  // Pool cap: if at max capacity, wait for any busy worker to finish rather than spawning
  if (workers.length >= WORKER_POOL_MAX) {
    beacon.hit("worker.pool_cap_wait")
    log.info("Worker pool at capacity, waiting for a worker to become free", { current: workers.length, max: WORKER_POOL_MAX })
    const busyWorkers = workers.filter((w) => w.busy && w.current)
    if (busyWorkers.length > 0) {
      // Wait for the first busy worker to finish its current request
      await Promise.race(busyWorkers.map((w) =>
        new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (!w.busy && w.ready) { clearInterval(check); resolve() }
          }, 500)
          setTimeout(() => { clearInterval(check); resolve() }, WORKER_READY_TIMEOUT_MS)
        })
      ))
      const freed = workers.find((w) => !w.busy && w.ready)
      if (freed) return freed
    }
    // If still no worker available, allow one over cap as last resort
    log.warn("No worker freed within timeout, spawning over cap", { current: workers.length, max: WORKER_POOL_MAX })
  }

  const worker = spawnWorker(config)
  await Promise.race([worker.readyPromise, Bun.sleep(WORKER_READY_TIMEOUT_MS)])
  if (!worker.ready) throw new Error("subagent worker failed to become ready")
  return worker
}

async function ensureStandbyWorker(config: Awaited<ReturnType<typeof Config.get>>) {
  beacon.hit("worker.ensure_standby")
  const log = Log.create({ service: "task.worker" })
  if (workers.some((w) => !w.busy && w.ready)) return
  // Respect pool cap: do not spawn standby if already at max
  if (workers.length >= WORKER_POOL_MAX) {
    beacon.hit("worker.standby_skipped_pool_cap")
    log.debug("Skipping standby spawn: pool at capacity", { current: workers.length, max: WORKER_POOL_MAX })
    return
  }
  if (standbySpawn) return standbySpawn
  standbySpawn = (async () => {
    try {
      const worker = spawnWorker(config)
      await Promise.race([worker.readyPromise, Bun.sleep(WORKER_READY_TIMEOUT_MS)])
      if (!worker.ready) {
        ProcessSupervisor.kill(worker.id)
        removeWorker(worker.id)
        log.warn("standby worker failed readiness and was killed", { workerID: worker.id })
      }
    } finally {
      standbySpawn = undefined
    }
  })()
  return standbySpawn
}

async function assignWorker(input: { config: Awaited<ReturnType<typeof Config.get>>; abort: AbortSignal }) {
  using _lock = await Lock.write(WORKER_ASSIGN_LOCK)
  if (input.abort.aborted) throw new Error("task canceled before worker assignment")
  const worker = await getReadyWorker(input.config)
  if (input.abort.aborted) throw new Error("task canceled before worker dispatch")
  cancelIdleReap(worker)
  worker.busy = true
  return worker
}

async function dispatchToWorker(input: {
  sessionID: string
  config: Awaited<ReturnType<typeof Config.get>>
  abort: AbortSignal
  onPhase?: (phase: string, data?: Record<string, unknown>) => void
}) {
  beacon.hit("worker.dispatch")
  let worker: TaskWorker | undefined
  let requestID: string | undefined
  const onAbort = () => {
    input.onPhase?.("worker_abort_signal")
    if (!worker || !requestID) return
    try {
      const stdin = worker.proc.stdin
      if (typeof stdin !== "number") {
        stdin?.write(
          JSON.stringify({
            type: "cancel",
            id: requestID,
            sessionID: input.sessionID,
          }) + "\n",
        )
      }
      input.onPhase?.("worker_cancel_sent", { workerID: worker.id, requestID })
    } catch {
      // ignore
    }
  }
  input.abort.addEventListener("abort", onAbort)
  try {
    if (input.abort.aborted) throw new Error("task canceled before worker assignment")

    worker = await assignWorker({ config: input.config, abort: input.abort })
    beacon.hit("worker.assigned")
    input.onPhase?.("worker_assigned", { workerID: worker.id })
    void ensureStandbyWorker(input.config)

    requestID = Identifier.ascending("message")
    const done = new Promise<WorkerRunResult>((resolve, reject) => {
      worker!.current = {
        id: requestID!,
        sessionID: input.sessionID,
        createdAt: Date.now(),
        eventCount: 0,
        resolve,
        reject,
      }
    })

    worker.current!.dispatchedAt = Date.now()
    const stdin = worker.proc.stdin
    if (typeof stdin !== "number") {
      stdin?.write(
        JSON.stringify({
          type: "run",
          id: requestID,
          sessionID: input.sessionID,
        }) + "\n",
      )
    }
    input.onPhase?.("worker_dispatched", { workerID: worker.id, requestID })
    await Bus.publish(TaskWorkerEvent.Assigned, {
      workerID: worker.id,
      sessionID: input.sessionID,
    })

    const result = await done
    beacon.hit("worker.result")
    input.onPhase?.("worker_done", {
      workerID: result.workerID,
      requestID: result.requestID,
      eventCount: result.eventCount,
      hasFirstEvent: !!result.firstEventAt,
    })
    return result
  } catch (error) {
    if (worker && !requestID && !worker.current) {
      worker.busy = false
      void ensureStandbyWorker(input.config)
    }
    throw error
  } finally {
    input.abort.removeEventListener("abort", onAbort)
  }
}

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary" && a.hidden !== true))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const telemetryLog = Log.create({ service: "task.telemetry" })
      const startedAt = Date.now()
      const marks = new Map<string, number>()
      let assignedWorkerID: string | undefined
      let linkedTodo:
        | {
            id: string
            content: string
            status: string
            action?: (typeof Todo.Info.shape.action)["_output"]
          }
        | undefined
      try {
        let subSessionID: string | undefined
        const mark = (name: string, data?: Record<string, unknown>) => {
          const now = Date.now()
          marks.set(name, now)
          debugCheckpoint("task.timeline", name, {
            callID: ctx.callID,
            sessionID: ctx.sessionID,
            elapsedMs: now - startedAt,
            ...data,
          })
        }
        const elapsedFromStart = () => Date.now() - startedAt
        const stageOnTimeout = () => {
          if (!marks.has("worker_assigned")) return "queue"
          if (!marks.has("worker_dispatched")) return "dispatch"
          if (!marks.has("first_bridge_event")) return "modeling"
          return "finalize"
        }
        using __telemetry = defer(() => {
          telemetryLog.info("task lifecycle timing", {
            callID: ctx.callID,
            parentSessionID: ctx.sessionID,
            subSessionID,
            totalMs: Date.now() - startedAt,
            timeline: Array.from(marks.entries()).map(([name, ts]) => ({ name, ms: ts - startedAt })),
          })
        })

        mark("start", { subagentType: params.subagent_type, hasSessionID: !!params.session_id })
        debugCheckpoint("task", "Task tool execute started", {
          description: params.description,
          subagent_type: params.subagent_type,
          session_id: params.session_id,
          model_param: params.model,
        })

        const config = await Config.get()
        mark("config_loaded")

        // Skip permission check when user explicitly invoked via @ or command subtask
        if (!ctx.extra?.bypassAgentCheck) {
          await ctx.ask({
            permission: "task",
            patterns: [params.subagent_type],
            always: ["*"],
            metadata: {
              description: params.description,
              subagent_type: params.subagent_type,
            },
          })
        }
        mark("permission_checked", { bypassed: !!ctx.extra?.bypassAgentCheck })

        const agent = await Agent.get(params.subagent_type)
        if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
        debugCheckpoint("task", "Agent loaded", { agentName: agent.name, agentModel: agent.model })
        mark("agent_loaded", { agent: agent.name })

        const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
        const toolWhitelist = toolWhitelistForSubagent(agent.name)

        const session = await iife(async () => {
          if (params.session_id) {
            const found = await Session.get(params.session_id).catch(() => {})
            if (found) return found
          }

          const narrowedPermissions: PermissionNext.Ruleset = toolWhitelist
            ? [
                { permission: "*", pattern: "*", action: "deny" },
                ...toolWhitelist.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
              ]
            : []

          return await Session.create({
            parentID: ctx.sessionID,
            title: createSubsessionTitle(params, agent.name),
            permission: [
              ...narrowedPermissions,
              {
                permission: "todowrite",
                pattern: "*",
                action: "deny",
              },
              {
                permission: "todoread",
                pattern: "*",
                action: "deny",
              },
              ...(hasTaskPermission
                ? []
                : [
                    {
                      permission: "task" as const,
                      pattern: "*" as const,
                      action: "deny" as const,
                    },
                  ]),
              // Subagents trust main agent's delegation — no interactive
              // external_directory prompts that they cannot answer.
              {
                permission: "external_directory" as const,
                pattern: "*" as const,
                action: "allow" as const,
              },
              ...(config.experimental?.primary_tools?.map((t) => ({
                pattern: "*",
                action: "allow" as const,
                permission: t,
              })) ?? []),
            ],
          })
        })
        mark("subsession_ready", { subSessionID: session.id })
        subSessionID = session.id
        const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
        if (msg.info.role !== "assistant") throw new Error("Not an assistant message")
        const parentSession = await Session.get(ctx.sessionID).catch(() => undefined)
        const pinnedExecution = parentSession?.execution

        // Parent model = session identity baseline
        const parentModel = pinnedExecution
          ? { modelID: pinnedExecution.modelID, providerId: pinnedExecution.providerId, accountId: pinnedExecution.accountId }
          : { modelID: msg.info.modelID, providerId: msg.info.providerId, accountId: "accountId" in msg.info ? (msg.info as any).accountId : undefined }

        // Validate LLM-specified model against user's visible model list (favorites).
        // Only models the user has explicitly enabled are allowed.
        let model = parentModel
        let modelSource = pinnedExecution ? "pinned_execution" : "message_model"
        if (params.model) {
          const parsed = Provider.parseModel(params.model)
          const modelKey = `${parsed.providerId}/${parsed.modelID}`
          // Load user's favorite/visible model list
          let allowed: Set<string> | undefined
          try {
            const modelFile = Bun.file(path.join(Global.Path.state, "model.json"))
            if (await modelFile.exists()) {
              const modelData = await modelFile.json()
              const favorites: Array<{ providerId: string; modelID: string }> = modelData.favorite ?? []
              if (favorites.length > 0) {
                allowed = new Set(favorites.map((f) => `${f.providerId}/${f.modelID}`))
              }
            }
          } catch { /* ignore read errors */ }

          if (allowed && !allowed.has(modelKey)) {
            // LLM specified a model not in user's visible list — reject
            debugCheckpoint("syslog.subagent", "task: explicit model rejected (not in user's visible list)", {
              requested: modelKey,
              allowedCount: allowed.size,
              fallback: parentModel,
            })
          } else if (parsed.providerId !== parentModel.providerId) {
            // Cross-provider — reject
            debugCheckpoint("syslog.subagent", "task: explicit model rejected (cross-provider)", {
              requested: modelKey,
              parentProvider: parentModel.providerId,
            })
          } else {
            model = { ...parsed, accountId: parentModel.accountId }
            modelSource = "explicit_validated"
          }
        }

        debugCheckpoint("syslog.subagent", "task: subagent model resolved", {
          parentSessionID: ctx.sessionID,
          childSessionID: session.id,
          agentName: agent.name,
          parentModel,
          resolvedModel: model,
          source: modelSource,
          llmRequested: params.model ?? "none",
        })

        // FIX: Pin execution identity on child session immediately so the
        // worker process inherits the correct provider/account and does not
        // drift to the global active account during its prompt loop.
        await Session.pinExecutionIdentity({
          sessionID: session.id,
          model: {
            providerId: model.providerId,
            modelID: model.modelID,
            accountId: model.accountId,
          },
        })

        // SYSLOG: Log final subagent model decision
        debugCheckpoint("syslog.subagent", "task: subagent model decision", {
          parentSessionID: ctx.sessionID,
          childSessionID: session.id,
          agentName: agent.name,
          selectedModel: model,
          selectedSource: modelSource,
          parentAccountId: parentModel.accountId,
          childAccountId: model.accountId,
          accountMismatch: parentModel.accountId !== model.accountId,
          pinnedToChild: true,
        })
        linkedTodo =
          (await Todo.get(ctx.sessionID)).find((todo) => todo.status === "in_progress") ??
          (await Todo.get(ctx.sessionID)).find((todo) => todo.status === "pending")

        debugCheckpoint("task", "Model resolved for subagent", {
          llmRequested: params.model,
          parentModel,
          finalModel: model,
          source: modelSource,
        })
        mark("model_resolved", { providerId: model.providerId, modelID: model.modelID })

        ctx.metadata({
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
            modelSource,
            todo: linkedTodo
              ? {
                  id: linkedTodo.id,
                  content: linkedTodo.content,
                  status: linkedTodo.status,
                  action: linkedTodo.action,
                }
              : undefined,
          },
        })

        const messageID = Identifier.ascending("message")
        const parts: Record<string, { id: string; tool: string; state: { status: string; title?: string } }> = {}
        const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
          if (evt.properties.part.sessionID !== session.id) return
          if (evt.properties.part.messageID === messageID) return
          if (evt.properties.part.type !== "tool") return
          const part = evt.properties.part
          parts[part.id] = {
            id: part.id,
            tool: part.tool,
            state: {
              status: part.state.status,
              title: part.state.status === "completed" ? part.state.title : undefined,
            },
          }
          ctx.metadata({
            title: params.description,
            metadata: {
              sessionId: session.id,
              model,
              todo: linkedTodo
                ? {
                    id: linkedTodo.id,
                    content: linkedTodo.content,
                    status: linkedTodo.status,
                    action: linkedTodo.action,
                  }
                : undefined,
            },
          })
        })

        function cancel() {
          SessionPrompt.cancel(session.id)
        }
        ctx.abort.addEventListener("abort", cancel)
        using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

        // Normalize prompt: convert complex structured input to simple string for resolvePromptParts
        // This maintains backward compatibility while supporting the new complex input format
        let normalizedPrompt: string
        if (typeof params.prompt === "string") {
          normalizedPrompt = params.prompt
        } else {
          // Convert structured input to human-readable format with metadata hint
          let structured = `[${params.prompt.type.toUpperCase()}]\n${params.prompt.content}`
          if (params.prompt.metadata && Object.keys(params.prompt.metadata).length > 0) {
            structured += `\n\nMetadata: ${JSON.stringify(params.prompt.metadata, null, 2)}`
          }
          normalizedPrompt = structured
        }

        const promptParts = await SessionPrompt.resolvePromptParts(normalizedPrompt)
        mark("prompt_parts_resolved", { partCount: promptParts.length })

        // Add USER message to the session before spawning execution process
        // This mimics what SessionPrompt.prompt does but allows us to execute the loop in a separate process
        const userMessageInfo: MessageV2.User = {
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: agent.name,
          model: {
            modelID: model.modelID,
            providerId: model.providerId,
            accountId: model.accountId,
          },
          time: {
            created: Date.now(),
          },
          variant: "normal", // Default variant
        }

        await Session.updateMessage(userMessageInfo)

        for (const part of promptParts) {
          await Session.updatePart({
            ...part,
            id: Identifier.ascending("part"),
            messageID: userMessageInfo.id,
            sessionID: session.id,
          })
        }
        mark("subsession_seeded")

        debugCheckpoint("task", "Dispatching subagent session to worker", { sessionID: session.id })

        // Register logical task run in supervisor for monitor visibility.
        if (ctx.callID) {
          ProcessSupervisor.register({
            id: ctx.callID,
            kind: "task-subagent",
            sessionID: session.id,
            parentSessionID: ctx.sessionID,
          })
        }

        // Link abort signal to process kill via Manager
        const cleanup = () => {
          if (ctx.callID) ProcessSupervisor.kill(ctx.callID)
          SessionPrompt.cancel(session.id)
        }
        ctx.abort.addEventListener("abort", cleanup)

        // Activity-based timeout: subagent stays alive as long as it's working.
        // Only times out after INACTIVITY_TIMEOUT_MS of no heartbeat/events.
        // Hard cap (MAX_EXECUTION_MS) prevents truly runaway processes.
        const INACTIVITY_TIMEOUT_MS = config.experimental?.task_timeout ?? 3 * 60 * 1000 // 3 min no activity = dead
        const MAX_EXECUTION_MS = 60 * 60 * 1000 // 1 hour hard cap

        // Activity tracking strategy (v2): heartbeat/event-first with low-frequency storage fallback.
        // Keep orphan/zombie safety by preserving stale detection + supervisor stall markers.
        let lastActivityTime = Date.now()
        let lastSignature = ""
        let lastFallbackPollAt = 0

        const updateActivity = () => {
          lastActivityTime = Date.now()
          if (ctx.callID) ProcessSupervisor.touch(ctx.callID)
        }

        const FALLBACK_POLL_INTERVAL_MS = 60_000
        const sampleChildActivity = async () => {
          const messages = await Session.messages({ sessionID: session.id })
          const last = messages.at(-1)?.info
          const lastTime = last?.time as { created?: number; completed?: number } | undefined
          const signature = `${messages.length}:${last?.id ?? ""}:${lastTime?.completed ?? lastTime?.created ?? 0}`
          if (signature !== lastSignature) {
            lastSignature = signature
            updateActivity()
            return true
          }
          return false
        }

        // Prime baseline once, then rely on worker heartbeat/events unless stale.
        await sampleChildActivity().catch(() => false)

        // Heartbeat check: if no activity for too long, process may be zombified
        const HEARTBEAT_INTERVAL_MS = 10_000 // Check frequently with cheap in-memory signals
        const HEARTBEAT_STALE_MS = 120_000 // Consider stale after 2 minutes of no activity

        const heartbeatTimer = setInterval(() => {
          const worker = assignedWorkerID ? workers.find((w) => w.id === assignedWorkerID) : undefined
          const workerHeartbeatAge = worker?.lastHeartbeatAt ? Date.now() - worker.lastHeartbeatAt : undefined
          const workerEventAge = worker?.current?.lastEventAt ? Date.now() - worker.current.lastEventAt : undefined

          if (
            (workerHeartbeatAge !== undefined && workerHeartbeatAge < HEARTBEAT_STALE_MS) ||
            (workerEventAge !== undefined && workerEventAge < HEARTBEAT_STALE_MS)
          ) {
            updateActivity()
          }

          const staleDuration = Date.now() - lastActivityTime

          // Emergency storage probe only when activity appears stale and not too frequently.
          if (staleDuration > HEARTBEAT_INTERVAL_MS && Date.now() - lastFallbackPollAt > FALLBACK_POLL_INTERVAL_MS) {
            lastFallbackPollAt = Date.now()
            void sampleChildActivity().catch((error) => {
              Log.create({ service: "task" }).debug("Failed to fallback-poll subagent activity", {
                callID: ctx.callID,
                sessionID: session.id,
                error: error instanceof Error ? error.message : String(error),
              })
            })
          }

          if (staleDuration > HEARTBEAT_STALE_MS) {
            if (ctx.callID) ProcessSupervisor.markStalled(ctx.callID)
            Log.create({ service: "task" }).warn("Subagent appears stalled, no activity detected", {
              callID: ctx.callID,
              sessionID: session.id,
              staleDurationMs: staleDuration,
            })
          }
        }, HEARTBEAT_INTERVAL_MS)

        try {
          // Activity-based timeout: polls inactivity instead of absolute deadline.
          // Worker stays alive as long as heartbeats/events keep flowing.
          const timeoutPromise = new Promise<"timeout">((resolve) => {
            const checkInterval = setInterval(() => {
              const inactiveMs = Date.now() - lastActivityTime
              const totalMs = Date.now() - startedAt
              if (inactiveMs > INACTIVITY_TIMEOUT_MS || totalMs > MAX_EXECUTION_MS) {
                clearInterval(checkInterval)
                resolve("timeout")
              }
            }, 5_000) // Check every 5s
          })

          const result = await Promise.race([
            dispatchToWorker({
              sessionID: session.id,
              config,
              abort: ctx.abort,
              onPhase: (phase, data) => {
                if (phase === "worker_assigned" && typeof data?.workerID === "string") {
                  assignedWorkerID = data.workerID
                }
                mark(phase, data)
              },
            }).then((run) => ({ type: "done" as const, run })),
            timeoutPromise,
          ])

          if (result === "timeout") {
            const inactiveMs = Date.now() - lastActivityTime
            const totalMs = Date.now() - startedAt
            const reason = totalMs > MAX_EXECUTION_MS ? "hard_cap" : "inactivity"
            mark("timed_out", { stage: stageOnTimeout(), reason, inactiveMs, totalMs })
            Log.create({ service: "task" }).error("Subagent execution timed out", {
              callID: ctx.callID,
              sessionID: session.id,
              reason,
              inactiveMs,
              totalMs,
              inactivityThresholdMs: INACTIVITY_TIMEOUT_MS,
              hardCapMs: MAX_EXECUTION_MS,
              timeoutStage: stageOnTimeout(),
              elapsedMs: elapsedFromStart(),
              workerID: assignedWorkerID,
              workerHeartbeatAgeMs: (() => {
                if (!assignedWorkerID) return undefined
                const worker = workers.find((w) => w.id === assignedWorkerID)
                if (!worker?.lastHeartbeatAt) return undefined
                return Date.now() - worker.lastHeartbeatAt
              })(),
            })
            SessionPrompt.cancel(session.id)
            throw new Error(
              reason === "hard_cap"
                ? `Subagent execution hit hard cap after ${Math.round(totalMs / 1000)}s`
                : `Subagent execution timed out after ${Math.round(inactiveMs / 1000)}s of inactivity`,
            )
          }
          if (result.type === "done" && result.run.firstEventAt) {
            marks.set("first_bridge_event", result.run.firstEventAt)
          }
          mark("worker_completed", {
            eventCount: result.type === "done" ? result.run.eventCount : 0,
            firstEventMs:
              result.type === "done" && result.run.firstEventAt ? result.run.firstEventAt - startedAt : undefined,
          })
          if (linkedTodo?.id) {
            await Todo.reconcileProgress({
              sessionID: ctx.sessionID,
              linkedTodoID: linkedTodo.id,
              taskStatus: "completed",
            }).catch(() => undefined)
          }
        } finally {
          clearInterval(heartbeatTimer)
          ctx.abort.removeEventListener("abort", cleanup)
          unsub()
          if (ctx.callID) ProcessSupervisor.kill(ctx.callID)
        }

        // Read the result from the session logs
        const messages = await Session.messages({ sessionID: session.id })
        mark("result_loaded", { messageCount: messages.length })
        const assistantMessages = messages.filter((x) => x.info.role === "assistant")
        if (assistantMessages.length === 0) {
          throw new Error("Subagent exited without assistant output")
        }
        const lastAssistant = assistantMessages.at(-1)!
        const text = lastAssistant.parts.findLast((x) => x.type === "text")?.text ?? ""

        // Check for error in message info if applicable (though V2 messages structure stores errors differently generally)
        // We rely on the text output primarily for the "result"

        const isToolPart = (part: MessageV2.Part): part is MessageV2.ToolPart => part.type === "tool"
        const summary = messages
          .filter((x) => x.info.role === "assistant")
          .flatMap((msg) => msg.parts.filter(isToolPart))
          .map((part) => ({
            id: part.id,
            tool: part.tool,
            state: {
              status: part.state.status,
              title: part.state.status === "completed" ? part.state.title : undefined,
            },
          }))

        const output = text + "\n\n" + ["<task_metadata>", `session_id: ${session.id}`, "</task_metadata>"].join("\n")
        mark("finished", { outputChars: output.length, toolSummaryCount: summary.length })

        return {
          title: params.description,
          metadata: {
            summary,
            sessionId: session.id,
            model,
            todo: linkedTodo
              ? {
                  id: linkedTodo.id,
                  content: linkedTodo.content,
                  status: linkedTodo.status,
                  action: linkedTodo.action,
                }
              : undefined,
          },
          output,
        }
      } catch (error: unknown) {
        if (linkedTodo?.id) {
          await Todo.reconcileProgress({
            sessionID: ctx.sessionID,
            linkedTodoID: linkedTodo.id,
            taskStatus: "error",
          }).catch(() => undefined)
        }
        throw error
      }
    },
  }
})
