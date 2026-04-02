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
import { Instance } from "@/project/instance"
import { SharedContext } from "@/session/shared-context"
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
  model: z
    .string()
    .describe(
      "Optional model override (must exist in user's available model list). Omit to inherit parent session model.",
    )
    .optional(),
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
      parentSessionID: Identifier.schema("session"),
      parentMessageID: Identifier.schema("message"),
      toolCallID: z.string(),
      linkedTodoID: z.string().optional(),
    }),
  ),
  Failed: BusEvent.define(
    "task.worker.failed",
    z.object({
      workerID: z.string(),
      sessionID: Identifier.schema("session"),
      parentSessionID: Identifier.schema("session"),
      parentMessageID: Identifier.schema("message"),
      toolCallID: z.string(),
      linkedTodoID: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  Removed: BusEvent.define(
    "task.worker.removed",
    z.object({
      workerID: z.string(),
    }),
  ),
}

/**
 * Bridged from worker → parent when a child session hits a rate limit
 * and needs the parent to decide the new model.
 */
export const TaskRateLimitEscalationEvent = BusEvent.define(
  "task.rate_limit_escalation",
  z.object({
    sessionID: z.string(),
    currentModel: z.object({
      providerId: z.string(),
      modelID: z.string(),
      accountId: z.string().optional(),
    }),
    error: z.string(),
    triedVectors: z.array(z.string()),
  }),
)

const TaskActiveChildTodoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.string(),
  action: Todo.Info.shape.action.optional(),
})

const SessionActiveChildPayloadSchema = z.object({
  parentSessionID: Identifier.schema("session"),
  activeChild: z
    .object({
      sessionID: Identifier.schema("session"),
      parentMessageID: Identifier.schema("message"),
      toolCallID: z.string(),
      workerID: z.string(),
      title: z.string(),
      agent: z.string(),
      status: z.enum(["running", "handoff"]),
      dispatchedAt: z.number().optional(),
      todo: TaskActiveChildTodoSchema.optional(),
    })
    .nullable(),
})

export const SessionActiveChildEvent = BusEvent.define("session.active-child.updated", SessionActiveChildPayloadSchema)

export type SessionActiveChildState = NonNullable<z.infer<typeof SessionActiveChildPayloadSchema>["activeChild"]>

function createActiveChildState() {
  const data: Record<string, SessionActiveChildState | undefined> = {}
  return data
}

let activeChildStateGetter: (() => ReturnType<typeof createActiveChildState>) | undefined
let activeChildFallbackState: ReturnType<typeof createActiveChildState> | undefined

function activeChildState() {
  if (typeof Instance.state === "function") {
    activeChildStateGetter ||= Instance.state(createActiveChildState)
    return activeChildStateGetter()
  }

  activeChildFallbackState ||= createActiveChildState()
  return activeChildFallbackState
}

export namespace SessionActiveChild {
  export function get(parentSessionID: string) {
    return activeChildState()[parentSessionID]
  }

  export async function set(parentSessionID: string, activeChild: SessionActiveChildState | null) {
    if (activeChild === null) delete activeChildState()[parentSessionID]
    else activeChildState()[parentSessionID] = activeChild
    await Bus.publish(SessionActiveChildEvent, {
      parentSessionID,
      activeChild,
    })
  }
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
    case TaskRateLimitEscalationEvent.type:
      await handleRateLimitEscalation(event.properties)
      return
  }
}

/**
 * Handle a rate-limit escalation from a child session.
 * Read the parent's current execution identity and push it to the worker.
 */
async function handleRateLimitEscalation(props: {
  sessionID: string
  currentModel: { providerId: string; modelID: string; accountId?: string }
  error: string
  triedVectors: string[]
}) {
  const log = Log.create({ service: "task.escalation" })
  const childSessionID = props.sessionID

  // Find the worker running this child session
  const worker = workers.find((w) => w.current?.sessionID === childSessionID)
  if (!worker) {
    log.warn("Escalation received but no worker found for session", { childSessionID })
    return
  }

  // Find the parent session ID from the worker's current request
  const parentSessionID = worker.current?.parentSessionID
  if (!parentSessionID) {
    log.warn("Escalation received but worker has no parentSessionID", { childSessionID })
    return
  }

  // Read parent session's execution identity to determine what model to use
  const parentSession = await Session.get(parentSessionID).catch(() => undefined)
  if (!parentSession?.execution) {
    log.warn("Escalation: parent session has no execution identity", { parentSessionID, childSessionID })
    return
  }

  const newModel = {
    providerId: parentSession.execution.providerId,
    modelID: parentSession.execution.modelID,
    accountId: parentSession.execution.accountId,
  }

  debugCheckpoint("syslog.rotation", "parent handling child escalation — sending model_update", {
    parentSessionID,
    childSessionID,
    parentModel: newModel,
    childCurrentModel: props.currentModel,
  })

  // Send model_update command to worker via stdin
  const stdin = worker.proc.stdin
  if (typeof stdin === "number") {
    log.error("Escalation: worker stdin not writable", { workerID: worker.id, childSessionID })
    return
  }
  try {
    stdin?.write(
      JSON.stringify({
        type: "model_update",
        sessionID: childSessionID,
        providerId: newModel.providerId,
        modelID: newModel.modelID,
        accountId: newModel.accountId,
      }) + "\n",
    )
  } catch (err) {
    log.error("Escalation: failed to write model_update to worker stdin", {
      workerID: worker.id,
      childSessionID,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Update child session's pinned execution identity
  await Session.pinExecutionIdentity({
    sessionID: childSessionID,
    model: newModel,
  }).catch((err) => {
    log.warn("Escalation: failed to pin child execution identity", {
      childSessionID,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

type WorkerRequest = {
  id: string
  sessionID: string
  parentSessionID: string
  parentMessageID: string
  toolCallID: string
  linkedTodoID?: string
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

type TaskActiveChildTodo = z.infer<typeof TaskActiveChildTodoSchema>

function toActiveChildTodo(
  linkedTodo:
    | {
        id: string
        content: string
        status: string
        action?: (typeof Todo.Info.shape.action)["_output"]
      }
    | undefined,
): TaskActiveChildTodo | undefined {
  if (!linkedTodo) return
  return {
    id: linkedTodo.id,
    content: linkedTodo.content,
    status: linkedTodo.status,
    action: linkedTodo.action,
  }
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
  // Capture Instance context at spawn time so the fire-and-forget stdout reader
  // retains the correct project directory for Bus.publish() even after the
  // originating HTTP request's Instance.provide() scope has ended.
  const capturedDirectory = Instance.directory
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
      if (done) {
        // Flush remaining buffer — worker may exit before final \n
        buffer += decoder.decode(undefined, { stream: false })
        const remaining = buffer.trim()
        if (remaining) {
          log.info("worker stdout flush remaining buffer", { workerID, length: remaining.length })
          for (const leftover of remaining.split("\n")) {
            if (!leftover.startsWith(WORKER_PREFIX)) continue
            let fMsg: any
            try {
              fMsg = JSON.parse(leftover.slice(WORKER_PREFIX.length))
            } catch {
              continue
            }
            if (fMsg?.type === "done" && worker.current?.id === fMsg.id) {
              log.info("worker done recovered from unflushed buffer", {
                workerID,
                sessionID: worker.current?.sessionID,
              })
              beacon.hit("worker.done")
              worker.lastPhase = "done"
              const req = worker.current
              worker.current = undefined
              worker.busy = false
              scheduleIdleReap(worker)
              if (!req) continue
              if (fMsg.ok) {
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
                Bus.publish(
                  TaskWorkerEvent.Done,
                  {
                    workerID: worker.id,
                    sessionID: req.sessionID,
                    parentSessionID: req.parentSessionID,
                    parentMessageID: req.parentMessageID,
                    toolCallID: req.toolCallID,
                    linkedTodoID: req.linkedTodoID,
                  },
                  { directory: capturedDirectory },
                ).catch((err) => log.error("bus publish Done failed (flush)", { workerID, error: String(err) }))
              } else {
                Bus.publish(
                  TaskWorkerEvent.Failed,
                  {
                    workerID: worker.id,
                    sessionID: req.sessionID,
                    parentSessionID: req.parentSessionID,
                    parentMessageID: req.parentMessageID,
                    toolCallID: req.toolCallID,
                    linkedTodoID: req.linkedTodoID,
                    error: fMsg.error || "worker run failed",
                  },
                  { directory: capturedDirectory },
                ).catch((err) => log.error("bus publish Failed failed (flush)", { workerID, error: String(err) }))
                req.reject(new Error(fMsg.error || "worker run failed"))
              }
              void ensureStandbyWorker(config)
            }
          }
        }
        break
      }
      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const newline = buffer.indexOf("\n")
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)

        const bpIdx = line.indexOf(BRIDGE_PREFIX)
        if (bpIdx !== -1) {
          beacon.hit("worker.bridge_line")
          const payload = line.slice(bpIdx + BRIDGE_PREFIX.length)
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

        const wpIdx = line.indexOf(WORKER_PREFIX)
        if (wpIdx === -1) continue
        const payload = line.slice(wpIdx + WORKER_PREFIX.length)
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
            log.info("publishing TaskWorkerEvent.Done", {
              workerID: worker.id,
              sessionID: req.sessionID,
              parentSessionID: req.parentSessionID,
              toolCallID: req.toolCallID,
            })
            Bus.publish(
              TaskWorkerEvent.Done,
              {
                workerID: worker.id,
                sessionID: req.sessionID,
                parentSessionID: req.parentSessionID,
                parentMessageID: req.parentMessageID,
                toolCallID: req.toolCallID,
                linkedTodoID: req.linkedTodoID,
              },
              { directory: capturedDirectory },
            ).catch((err) =>
              log.error("bus publish TaskWorkerEvent.Done failed", { workerID: worker.id, error: String(err) }),
            )
          } else {
            log.info("publishing TaskWorkerEvent.Failed", {
              workerID: worker.id,
              sessionID: req.sessionID,
              parentSessionID: req.parentSessionID,
              toolCallID: req.toolCallID,
              error: msg.error,
            })
            Bus.publish(
              TaskWorkerEvent.Failed,
              {
                workerID: worker.id,
                sessionID: req.sessionID,
                parentSessionID: req.parentSessionID,
                parentMessageID: req.parentMessageID,
                toolCallID: req.toolCallID,
                linkedTodoID: req.linkedTodoID,
                error: msg.error || "worker run failed",
              },
              { directory: capturedDirectory },
            ).catch((err) =>
              log.error("bus publish TaskWorkerEvent.Failed failed", { workerID: worker.id, error: String(err) }),
            )
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
          Bus.publish(
            TaskWorkerEvent.Failed,
            {
              workerID: worker.id,
              sessionID: req.sessionID,
              parentSessionID: req.parentSessionID,
              parentMessageID: req.parentMessageID,
              toolCallID: req.toolCallID,
              linkedTodoID: req.linkedTodoID,
              error: "worker run canceled",
            },
            { directory: capturedDirectory },
          ).catch((err) =>
            log.error("bus publish TaskWorkerEvent.Failed failed (canceled)", {
              workerID: worker.id,
              error: String(err),
            }),
          )
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
            Bus.publish(
              TaskWorkerEvent.Failed,
              {
                workerID: worker.id,
                sessionID: req.sessionID,
                parentSessionID: req.parentSessionID,
                parentMessageID: req.parentMessageID,
                toolCallID: req.toolCallID,
                linkedTodoID: req.linkedTodoID,
                error: msg.error || "worker error",
              },
              { directory: capturedDirectory },
            ).catch((err) =>
              log.error("bus publish TaskWorkerEvent.Failed failed (error msg)", {
                workerID: worker.id,
                error: String(err),
              }),
            )
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
      log.info("worker exit with pending request, publishing TaskWorkerEvent.Failed", {
        workerID: worker.id,
        sessionID: req.sessionID,
        parentSessionID: req.parentSessionID,
        exitCode,
      })
      Bus.publish(
        TaskWorkerEvent.Failed,
        {
          workerID: worker.id,
          sessionID: req.sessionID,
          parentSessionID: req.parentSessionID,
          parentMessageID: req.parentMessageID,
          toolCallID: req.toolCallID,
          linkedTodoID: req.linkedTodoID,
          error: `worker process exited unexpectedly (exitCode=${exitCode})`,
        },
        { directory: capturedDirectory },
      ).catch((err) =>
        log.error("bus publish TaskWorkerEvent.Failed failed (exit)", { workerID: worker.id, error: String(err) }),
      )
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
    log.warn("existing worker not ready within timeout", {
      workerID: existing.id,
      timeoutMs: WORKER_READY_TIMEOUT_MS,
      lastPhase: existing.lastPhase,
      lastStderr: existing.lastStderr?.slice(-300),
    })
  }

  // Pool cap: if at max capacity, wait for any busy worker to finish rather than spawning
  if (workers.length >= WORKER_POOL_MAX) {
    beacon.hit("worker.pool_cap_wait")
    log.info("Worker pool at capacity, waiting for a worker to become free", {
      current: workers.length,
      max: WORKER_POOL_MAX,
    })
    const busyWorkers = workers.filter((w) => w.busy && w.current)
    if (busyWorkers.length > 0) {
      // Wait for the first busy worker to finish its current request
      await Promise.race(
        busyWorkers.map(
          (w) =>
            new Promise<void>((resolve) => {
              const check = setInterval(() => {
                if (!w.busy && w.ready) {
                  clearInterval(check)
                  resolve()
                }
              }, 500)
              setTimeout(() => {
                clearInterval(check)
                resolve()
              }, WORKER_READY_TIMEOUT_MS)
            }),
        ),
      )
      const freed = workers.find((w) => !w.busy && w.ready)
      if (freed) return freed
    }
    // If still no worker available, allow one over cap as last resort
    log.warn("No worker freed within timeout, spawning over cap", { current: workers.length, max: WORKER_POOL_MAX })
  }

  const worker = spawnWorker(config)
  await Promise.race([worker.readyPromise, Bun.sleep(WORKER_READY_TIMEOUT_MS)])
  if (!worker.ready) {
    const stderrHint = worker.lastStderr ? ` | stderr: ${worker.lastStderr.slice(-500)}` : ""
    log.error("worker failed to become ready", {
      workerID: worker.id,
      lastPhase: worker.lastPhase,
      lastStderr: worker.lastStderr?.slice(-500),
      timeoutMs: WORKER_READY_TIMEOUT_MS,
    })
    throw new Error(`subagent worker failed to become ready${stderrHint}`)
  }
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
  parentSessionID: string
  parentMessageID: string
  toolCallID: string
  linkedTodoID?: string
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
        parentSessionID: input.parentSessionID,
        parentMessageID: input.parentMessageID,
        toolCallID: input.toolCallID,
        linkedTodoID: input.linkedTodoID,
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

    const dispatchedAt = worker.current!.dispatchedAt
    void done.catch(() => undefined)
    return {
      workerID: worker.id,
      requestID,
      sessionID: input.sessionID,
      createdAt: worker.current!.createdAt,
      dispatchedAt,
      eventCount: worker.current!.eventCount,
      doneAt: dispatchedAt ?? Date.now(),
    }
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

/**
 * Terminate ALL active workers. Used by abort-all / kill-switch emergency stop.
 * Returns the number of workers that received a cancel signal.
 */
export function terminateAllActiveWorkers(): number {
  let canceled = 0
  for (const worker of workers) {
    const current = worker.current
    // Cancel both active (current set) and busy (LLM stream may still be running) workers
    if (!current && !worker.busy) continue
    let stdinOk = false
    if (current) {
      try {
        const stdin = worker.proc.stdin
        if (typeof stdin !== "number") {
          stdin?.write(
            JSON.stringify({
              type: "cancel",
              id: current.id,
              sessionID: current.sessionID,
            }) + "\n",
          )
          stdinOk = true
        }
      } catch {
        // stdin write failed — fall through to hard kill
      }
      // Clear UI state: remove the subagent status bar for the parent session
      if (current.parentSessionID) {
        void SessionActiveChild.set(current.parentSessionID, null)
      }
    }
    // Hard kill: if stdin cancel failed or worker had no current but was busy,
    // kill the process directly to ensure the subagent stops immediately.
    if (!stdinOk) {
      try {
        worker.proc.kill()
      } catch {
        // already dead
      }
    }
    canceled++
  }
  return canceled
}

export async function terminateActiveChild(parentSessionID: string) {
  const activeChild = SessionActiveChild.get(parentSessionID)
  if (!activeChild) return false
  if (activeChild.status !== "running") return false

  const worker =
    activeChild.workerID && activeChild.workerID !== "handoff"
      ? workers.find((candidate) => candidate.id === activeChild.workerID)
      : undefined
  if (!worker) return false

  // Try graceful cancel via stdin first
  let stdinOk = false
  const current = worker.current
  if (current) {
    try {
      const stdin = worker.proc.stdin
      if (typeof stdin !== "number") {
        stdin?.write(
          JSON.stringify({
            type: "cancel",
            id: current.id,
            sessionID: activeChild.sessionID,
          }) + "\n",
        )
        stdinOk = true
      }
    } catch {
      // stdin write failed — fall through to hard kill
    }
  }

  // Hard kill fallback: if stdin failed or worker.current was already cleared
  // but worker process is still alive, kill it directly
  if (!stdinOk) {
    try {
      worker.proc.kill()
    } catch {
      // already dead
    }
  }

  // Clear UI state: remove the subagent status bar immediately
  await SessionActiveChild.set(parentSessionID, null)
  return true
}

/**
 * Send a model_update to the active child worker of a parent session.
 * Used when the user manually changes the model in the main session.
 */
export async function sendModelUpdateToActiveChild(
  parentSessionID: string,
  model: { providerId: string; modelID: string; accountId?: string },
) {
  const activeChild = SessionActiveChild.get(parentSessionID)
  if (!activeChild || activeChild.status !== "running") return false
  if (!activeChild.workerID || activeChild.workerID === "handoff") return false

  const worker = workers.find((w) => w.id === activeChild.workerID)
  if (!worker?.current) return false
  if (worker.current.sessionID !== activeChild.sessionID) return false

  const stdin = worker.proc.stdin
  if (typeof stdin === "number") return false

  debugCheckpoint("syslog.rotation", "propagating manual model change to active child worker", {
    parentSessionID,
    childSessionID: activeChild.sessionID,
    workerID: worker.id,
    newModel: model,
  })

  try {
    stdin?.write(
      JSON.stringify({
        type: "model_update",
        sessionID: activeChild.sessionID,
        providerId: model.providerId,
        modelID: model.modelID,
        accountId: model.accountId,
      }) + "\n",
    )
  } catch {
    return false
  }

  // Also pin the child session's execution identity
  await Session.pinExecutionIdentity({
    sessionID: activeChild.sessionID,
    model,
  }).catch(() => {})

  return true
}

async function getAuthoritativeActiveChildForDispatch(parentSessionID: string) {
  const activeChild = SessionActiveChild.get(parentSessionID)
  if (!activeChild) return
  if (activeChild.status === "handoff") {
    // Child already completed; parent is resuming and may dispatch next subagent.
    // Clear the stale handoff state and allow dispatch.
    await SessionActiveChild.set(parentSessionID, null)
    return
  }
  if (activeChild.status !== "running") return

  const worker = workers.find((candidate) => candidate.id === activeChild.workerID)
  const current = worker?.current
  const isLive =
    !!worker &&
    !!current &&
    current.sessionID === activeChild.sessionID &&
    current.parentSessionID === parentSessionID &&
    current.toolCallID === activeChild.toolCallID

  if (isLive) return activeChild

  await SessionActiveChild.set(parentSessionID, null)
  return
}

async function assertNoAuthoritativeActiveChild(parentSessionID: string) {
  const activeChild = await getAuthoritativeActiveChildForDispatch(parentSessionID)
  if (!activeChild) return
  throw new Error(`active_child_dispatch_blocked:${parentSessionID}:${activeChild.sessionID}:${activeChild.status}`)
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

        const callerSession = await Session.get(ctx.sessionID)
        if (callerSession.parentID) {
          throw new Error(`nested_task_delegation_unsupported:${ctx.sessionID}`)
        }
        await assertNoAuthoritativeActiveChild(ctx.sessionID)

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
            // Only allow session reuse if the session was interrupted mid-execution
            // (workflow state = "running"). A completed/idle session must not be
            // reused for a new task — enforce new session creation unconditionally.
            if (found?.workflow?.state === "running") return found
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
          ? {
              modelID: pinnedExecution.modelID,
              providerId: pinnedExecution.providerId,
              accountId: pinnedExecution.accountId,
            }
          : {
              modelID: msg.info.modelID,
              providerId: msg.info.providerId,
              accountId: "accountId" in msg.info ? (msg.info as any).accountId : undefined,
            }

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
          } catch {
            /* ignore read errors */
          }

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

        const activeChildTodo = toActiveChildTodo(linkedTodo)

        ctx.metadata({
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
            modelSource,
            agent: agent.name,
            dispatched: true,
            status: "running",
            todo: activeChildTodo,
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
              modelSource,
              agent: agent.name,
              dispatched: true,
              status: "running",
              todo: activeChildTodo,
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

        // Context Sharing v2: SharedContext snapshot injection removed.
        // Child sessions now receive parent's full message history as a stable prefix
        // in prompt.ts (via parentMessagePrefix), which provides complete context
        // with near-zero cost due to automatic prompt caching.
        // SharedContext is retained for compaction/observability purposes only.

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
            sessionID: ctx.sessionID,
            parentSessionID: ctx.sessionID,
          })
        }

        // Link abort signal to process kill via Manager
        const cleanup = () => {
          if (ctx.callID) ProcessSupervisor.kill(ctx.callID)
          SessionPrompt.cancel(session.id)
        }
        ctx.abort.addEventListener("abort", cleanup)

        // Unconditional wait: never timeout a subagent.  Only give up when the
        // worker subprocess is confirmed dead.  Periodic liveness checks log
        // diagnostics but do NOT kill the worker.
        const LIVENESS_CHECK_INTERVAL_MS = 30_000

        const livenessTimer = setInterval(() => {
          const worker = assignedWorkerID ? workers.find((w) => w.id === assignedWorkerID) : undefined
          if (!worker) return // not yet assigned
          const proc = worker.proc
          const exited = proc.exitCode !== null || proc.killed
          if (exited) {
            Log.create({ service: "task" }).warn("Subagent worker process is dead", {
              callID: ctx.callID,
              sessionID: session.id,
              workerID: assignedWorkerID,
              exitCode: proc.exitCode,
              elapsedMs: elapsedFromStart(),
            })
            // The stdout reader will handle cleanup via the exit path;
            // just mark it stalled for observability.
            if (ctx.callID) ProcessSupervisor.markStalled(ctx.callID)
          } else {
            // Touch supervisor to signal we're still alive.
            if (ctx.callID) ProcessSupervisor.touch(ctx.callID)
          }
        }, LIVENESS_CHECK_INTERVAL_MS)

        try {
          const run = await dispatchToWorker({
            sessionID: session.id,
            parentSessionID: ctx.sessionID,
            parentMessageID: ctx.messageID,
            toolCallID: ctx.callID ?? session.id,
            linkedTodoID: linkedTodo?.id,
            config,
            abort: ctx.abort,
            onPhase: (phase, data) => {
              if (phase === "worker_assigned" && typeof data?.workerID === "string") {
                assignedWorkerID = data.workerID
                void SessionActiveChild.set(ctx.sessionID, {
                  sessionID: session.id,
                  parentMessageID: ctx.messageID,
                  toolCallID: ctx.callID ?? session.id,
                  workerID: data.workerID,
                  title: params.description,
                  agent: agent.name,
                  status: "running",
                  dispatchedAt: Date.now(),
                  todo: activeChildTodo,
                })
              }
              mark(phase, data)
            },
          })
          mark("worker_dispatched_return", {
            eventCount: run.eventCount,
            firstEventMs: undefined,
          })
        } finally {
          clearInterval(livenessTimer)
          ctx.abort.removeEventListener("abort", cleanup)
          unsub()
        }

        const output = [
          "Subagent dispatched in background.",
          "",
          "<task_metadata>",
          `session_id: ${session.id}`,
          "status: running",
          "</task_metadata>",
        ].join("\n")
        mark("finished", { outputChars: output.length })

        return {
          title: params.description,
          metadata: {
            dispatched: true,
            status: "running",
            sessionId: session.id,
            agent: agent.name,
            model,
            todo: activeChildTodo,
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
