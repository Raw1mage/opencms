import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { readdir, readFile } from "node:fs/promises"
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
import { LLM } from "../session/llm"
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
    return ["read", "glob", "grep", "list", "bash", "edit", "write", "apply_patch", "question", "skill", "todowrite", "todoread"]
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
  OrphanRecovered: BusEvent.define(
    "task.worker.orphan_recovered",
    z.object({
      sessionID: z.string(),
      parentSessionID: z.string(),
      parentMessageID: z.string(),
      toolCallID: z.string(),
      partID: z.string(),
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

/**
 * Running Task Registry — persists which tasks are in-flight so orphan recovery
 * after daemon restart is O(running tasks) instead of O(all sessions × all messages).
 */
const REGISTRY_FILENAME = "running-tasks.json"
function registryPath() {
  return path.join(Global.Path.data, REGISTRY_FILENAME)
}

interface RegistryEntry {
  sessionID: string        // child session
  parentSessionID: string
  parentMessageID: string
  toolCallID: string
  partID?: string
  registeredAt: number
}

async function registryRead(): Promise<Record<string, RegistryEntry>> {
  try {
    const raw = await Bun.file(registryPath()).text()
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function registryWrite(entries: Record<string, RegistryEntry>) {
  await Bun.write(registryPath(), JSON.stringify(entries))
}

export async function registryAdd(entry: RegistryEntry) {
  const entries = await registryRead()
  entries[entry.toolCallID] = entry
  await registryWrite(entries)
}

export async function registryRemove(toolCallID: string) {
  const entries = await registryRead()
  if (!(toolCallID in entries)) return
  delete entries[toolCallID]
  await registryWrite(entries)
}

/**
 * Recover orphan tasks from previous daemon instance.
 * Reads the persisted registry (a handful of entries at most),
 * marks each as error, then deletes the registry file.
 */
export async function recoverOrphanTasks() {
  const scanLog = Log.create({ service: "task.orphan-recovery" })
  const entries = await registryRead()
  const keys = Object.keys(entries)
  if (keys.length === 0) {
    scanLog.info("no orphan tasks to recover")
    return
  }

  scanLog.info("orphan recovery starting", { count: keys.length })
  let recovered = 0

  for (const [toolCallID, entry] of Object.entries(entries)) {
    try {
      // Find the specific message + part to mark as error
      for await (const msg of MessageV2.stream(entry.parentSessionID)) {
        if (msg.info.id !== entry.parentMessageID) continue
        for (const part of msg.parts) {
          if (part.callID !== toolCallID) continue
          if (part.state.status !== "running") continue

          scanLog.info("recovering orphan ToolPart", {
            parentSessionID: entry.parentSessionID,
            messageID: entry.parentMessageID,
            toolCallID,
            childSessionID: entry.sessionID,
          })

          await Session.updatePart({
            ...part,
            messageID: msg.info.id,
            sessionID: entry.parentSessionID,
            state: {
              ...part.state,
              status: "error",
              output: "daemon restarted while task was in-flight",
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          })

          await Bus.publish(TaskWorkerEvent.OrphanRecovered, {
            sessionID: entry.sessionID,
            parentSessionID: entry.parentSessionID,
            parentMessageID: entry.parentMessageID,
            toolCallID,
            partID: part.id,
          })

          recovered++
        }
        break // found the target message, no need to keep streaming
      }
    } catch (err) {
      scanLog.error("failed to recover orphan", {
        toolCallID,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Clear the registry — all entries have been processed
  try {
    const fs = await import("fs/promises")
    await fs.unlink(registryPath())
  } catch {}

  scanLog.info("orphan recovery complete", { recovered, total: keys.length })
  debugCheckpoint("task.orphan-recovery", "complete", { recovered, total: keys.length })
}

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
 *
 * Fix B1 (2026-04-18): run proper rotation3d on the parent side using the
 * child's triedVectors. Previously this just echoed parent.execution back to
 * the worker, which—when parent and child shared a rate-limited account—looped
 * the child through the same vector until either side timed out. Now we:
 *   1. Resolve the child's current Provider.Model and ask rotation3d
 *      for a fresh vector excluding triedVectors.
 *   2. If a fallback exists, push it to the worker via stdin model_update.
 *   3. If no fallback exists, do NOT push parent.execution (that would just
 *      re-hit the same 429). Let ModelUpdateSignal.wait() expire (30s) so
 *      the child fails fast with a clear error.
 */
async function handleRateLimitEscalation(props: {
  sessionID: string
  currentModel: { providerId: string; modelID: string; accountId?: string }
  error: string
  triedVectors: string[]
}) {
  const log = Log.create({ service: "task.escalation" })
  const childSessionID = props.sessionID
  // [rot-rca] Phase A instrument — parent-side timing
  const __rotRcaParentStart = Date.now()
  log.info("[rot-rca] parent recv", {
    childSessionID,
    accountIdTail: props.currentModel.accountId?.slice(-8),
    triedCount: props.triedVectors.length,
    ts: __rotRcaParentStart,
  })

  // Find the worker running this child session
  const worker = workers.find((w) => w.current?.sessionID === childSessionID)
  if (!worker) {
    log.warn("[rot-rca] parent no-worker — RW-3 race", { childSessionID, elapsedMs: Date.now() - __rotRcaParentStart })
    return
  }

  // Find the parent session ID from the worker's current request
  const parentSessionID = worker.current?.parentSessionID
  if (!parentSessionID) {
    log.warn("Escalation received but worker has no parentSessionID", { childSessionID })
    return
  }

  // Read parent session's execution identity for sessionIdentity hint only.
  const parentSession = await Session.get(parentSessionID).catch(() => undefined)

  // Resolve child's current Provider.Model (needed for rotation3d input).
  let currentProviderModel: Provider.Model | undefined
  try {
    currentProviderModel = await Provider.getModel(
      props.currentModel.providerId,
      props.currentModel.modelID,
    )
  } catch (err) {
    log.error("Escalation: cannot resolve child's current model for rotation", {
      childSessionID,
      providerId: props.currentModel.providerId,
      modelID: props.currentModel.modelID,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  const triedSet = new Set(props.triedVectors)
  const sessionIdentity =
    parentSession?.execution
      ? { providerId: parentSession.execution.providerId, accountId: parentSession.execution.accountId }
      : undefined
  const fallback = await LLM.handleRateLimitFallback(
    currentProviderModel,
    "account-first",
    triedSet,
    new Error(props.error),
    props.currentModel.accountId,
    sessionIdentity,
    { silent: true },
  ).catch((err) => {
    log.warn("[rot-rca] rotation3d threw", {
      childSessionID,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - __rotRcaParentStart,
    })
    return null
  })
  log.info("[rot-rca] parent fallback-done", {
    childSessionID,
    foundFallback: !!fallback,
    fallbackElapsedMs: Date.now() - __rotRcaParentStart,
  })

  if (!fallback) {
    log.warn("[rot-rca] H1 — no fallback, child will timeout", {
      childSessionID,
      parentSessionID,
      childCurrentModel: props.currentModel,
      triedVectors: props.triedVectors,
      elapsedMs: Date.now() - __rotRcaParentStart,
    })
    debugCheckpoint("syslog.rotation", "parent escalation: no fallback — child will timeout", {
      parentSessionID,
      childSessionID,
      triedVectors: props.triedVectors,
    })
    return
  }

  const newModel = {
    providerId: fallback.model.providerId,
    modelID: fallback.model.id,
    accountId: fallback.accountId,
  }

  debugCheckpoint("syslog.rotation", "parent handling child escalation — rotation3d found fallback", {
    parentSessionID,
    childSessionID,
    rotationPicked: newModel,
    childCurrentModel: props.currentModel,
    triedVectorCount: triedSet.size,
  })

  // Send model_update command to worker via stdin
  const stdin = worker.proc.stdin
  if (typeof stdin === "number") {
    log.error("Escalation: worker stdin not writable", { workerID: worker.id, childSessionID })
    return
  }
  const __rotRcaStdinStart = Date.now()
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
    log.info("[rot-rca] parent stdin-send", {
      childSessionID,
      stdinWriteMs: Date.now() - __rotRcaStdinStart,
      totalElapsedMs: Date.now() - __rotRcaParentStart,
    })
  } catch (err) {
    log.error("[rot-rca] RW-6 stdin write failed", {
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
  // Detect compiled binary vs dev mode (bun + source).
  // Bun compiled binaries embed the app in a virtual /$bunfs/ filesystem;
  // import.meta.url will start with "file:///$bunfs/" in that case.
  // We MUST NOT resolve relative .ts paths against bunfs — the layout
  // differs from the source tree and causes "Module not found" errors.
  const isCompiledBinary = import.meta.url.includes("/$bunfs/")

  if (isCompiledBinary) {
    // Compiled binary: just re-exec ourselves with the worker subcommand.
    return [process.execPath, "session", "worker"]
  }

  // Dev mode: bun + source entry point
  const indexScript = fileURLToPath(new URL("../index.ts", import.meta.url))
  return [process.argv[0], "run", indexScript, "session", "worker"]
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
        log.info("[TRACE][STDOUT_EOF] stdout EOF reached", { workerID, hasRemaining: remaining.length > 0, remainingLength: remaining.length, bufferPreview: remaining.slice(0, 200), hasCurrent: !!worker.current, currentId: worker.current?.id, workerPhase: worker.lastPhase })
        if (remaining) {
          log.info("[TRACE][FLUSH_START] flushing remaining stdout buffer", { workerID, length: remaining.length })
          for (const leftover of remaining.split("\n")) {
            if (!leftover.startsWith(WORKER_PREFIX)) continue
            let fMsg: any
            try {
              fMsg = JSON.parse(leftover.slice(WORKER_PREFIX.length))
            } catch {
              continue
            }
            log.info("[TRACE][FLUSH_MSG_FOUND] msg found in flush buffer", { workerID, fMsgType: fMsg?.type, fMsgId: fMsg?.id, hasCurrent: !!worker.current, currentId: worker.current?.id, idMatch: worker.current?.id === fMsg?.id })
            if (fMsg?.type === "done" && worker.current?.id === fMsg.id) {
              log.info("[TRACE][FLUSH_DONE_RECOVERED] done msg recovered from unflushed buffer", {
                workerID,
                sessionID: worker.current?.sessionID,
                parentSessionID: worker.current?.parentSessionID,
                toolCallID: worker.current?.toolCallID,
              })
              beacon.hit("worker.done")
              worker.lastPhase = "done"
              const req = worker.current
              worker.current = undefined
              if (req) registryRemove(req.toolCallID).catch(() => {})
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
          log.warn("worker message JSON parse failed", { workerID: worker?.id, payload: payload.slice(0, 100) })
          continue
        }
        
        log.info("[TRACE] worker message parsed", { workerID: worker?.id, msgType: msg?.type, msgId: msg?.id, hasCurrent: !!worker?.current, currentId: worker?.current?.id, workerBusy: worker?.busy, workerPhase: worker?.lastPhase })

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

        if (msg?.type === "done") {
          log.info("[TRACE][DONE_MSG_RECEIVED] done message arrived", { 
            workerID: worker.id, 
            msgId: msg.id,
            msgOk: msg.ok,
            msgError: msg.error,
            hasCurrent: !!worker.current, 
            currentId: worker.current?.id,
            currentSessionID: worker.current?.sessionID,
            currentParentSessionID: worker.current?.parentSessionID,
            currentToolCallID: worker.current?.toolCallID,
            idMatch: worker.current?.id === msg.id,
            workerBusy: worker.busy,
            workerPhase: worker.lastPhase,
          })
          if (!worker.current) {
            log.warn("[TRACE][DONE_MSG_NO_CURRENT] done msg received but worker.current is undefined — Done event will NOT be published!", {
              workerID: worker.id,
              msgId: msg.id,
            })
          } else if (worker.current.id !== msg.id) {
            log.warn("[TRACE][DONE_MSG_ID_MISMATCH] done msg id does not match worker.current.id — Done event will NOT be published!", {
              workerID: worker.id,
              msgId: msg.id,
              currentId: worker.current.id,
            })
          }
        }

        if (msg?.type === "done" && worker.current?.id === msg.id) {
          log.info("[TRACE][DONE_BRANCH_ENTERED] done processing started", { workerID: worker.id, msgId: msg.id, sessionID: worker.current?.sessionID, parentSessionID: worker.current?.parentSessionID, toolCallID: worker.current?.toolCallID })
          beacon.hit("worker.done")
          worker.lastPhase = "done"
          worker.lastWorkerMessage = typeof msg.error === "string" ? `done:${msg.error}` : "done"
          const req = worker.current
          worker.current = undefined
          if (req) registryRemove(req.toolCallID).catch(() => {})
          log.info("[TRACE][DONE_CURRENT_CLEARED] worker.current set to undefined after done", { workerID: worker.id, reqId: req?.id })
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
            log.info("[TRACE][BEFORE_DONE_PUBLISH] about to publish TaskWorkerEvent.Done", {
              workerID: worker.id,
              sessionID: req.sessionID,
              parentSessionID: req.parentSessionID,
              toolCallID: req.toolCallID,
              capturedDirectory,
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
            ).then(() => {
              log.info("[TRACE][DONE_PUBLISH_SUCCESS] TaskWorkerEvent.Done published successfully", { workerID: worker.id, sessionID: req.sessionID, parentSessionID: req.parentSessionID })
            }).catch((err) =>
              log.error("[TRACE][DONE_PUBLISH_FAILED] bus publish TaskWorkerEvent.Done FAILED", { workerID: worker.id, error: String(err) }),
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
          if (req) registryRemove(req.toolCallID).catch(() => {})
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
            registryRemove(req.toolCallID).catch(() => {})
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
    log.info("[TRACE][EXIT_HANDLER] stdout loop ended, entering exit handler", { workerID, hasReq: !!req, reqId: req?.id, reqSessionID: req?.sessionID, reqParentSessionID: req?.parentSessionID, reqToolCallID: req?.toolCallID, workerPhase: worker.lastPhase, workerBusy: worker.busy })
    worker.current = undefined
    if (req) registryRemove(req.toolCallID).catch(() => {})
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
    log.info("[TRACE][EXIT_COMPENSATION] checking if compensation needed", { workerID, hasReq: !!req, exitCode })
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
    // Point to worker's pre-bootstrap log file for post-mortem diagnosis
    const workerPid = worker.proc.pid
    const workerLogHint = workerPid
      ? ` | worker log: ${path.join(Global.Path.log, `worker-${workerPid}.log`)}`
      : ""
    log.error("worker failed to become ready", {
      workerID: worker.id,
      lastPhase: worker.lastPhase,
      lastStderr: worker.lastStderr?.slice(-500),
      timeoutMs: WORKER_READY_TIMEOUT_MS,
      workerPid,
      workerLogPath: workerPid ? path.join(Global.Path.log, `worker-${workerPid}.log`) : undefined,
    })
    throw new Error(`subagent worker failed to become ready${stderrHint}${workerLogHint}`)
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
    // Persist to running-task registry for orphan recovery on daemon restart
    registryAdd({
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID,
      toolCallID: input.toolCallID,
      registeredAt: Date.now(),
    }).catch((err) => log.warn("registry add failed", { toolCallID: input.toolCallID, error: String(err) }))
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
    return {
      workerID: worker.id,
      requestID,
      sessionID: input.sessionID,
      createdAt: worker.current!.createdAt,
      dispatchedAt,
      eventCount: worker.current!.eventCount,
      doneAt: dispatchedAt ?? Date.now(),
      metadata: { dispatched: true },
      // Direct completion channel: caller awaits this instead of relying on
      // the Bus event chain (worker.current id-match → Bus.publish → subscriber).
      // The promise resolves/rejects when the stdout reader processes "done"/"error"/"canceled"/exit.
      done: done.catch((err) => {
        throw err
      }),
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
        const log = Log.create({ service: "task.tool.execute" })
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

        log.info("DEBUG_RCA_STALL_SCAN: step 1: pinExecutionIdentity starting", { childSessionID: session.id })
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

        log.info("DEBUG_RCA_STALL_SCAN: step 2: resolvePromptParts starting", { childSessionID: session.id })
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

        log.info("DEBUG_RCA_STALL_SCAN: step 3: session message seed starting", { childSessionID: session.id })
        await Session.updateMessage(userMessageInfo)

        log.info("DEBUG_RCA_STALL_SCAN: step 4: session parts seed starting", { childSessionID: session.id })
        for (const part of promptParts) {
          await Session.updatePart({
            ...part,
            id: Identifier.ascending("part"),
            messageID: userMessageInfo.id,
            sessionID: session.id,
          })
        }
        mark("subsession_seeded")

        log.info("DEBUG_RCA_STALL_SCAN: step 5: dispatchToWorker starting", { childSessionID: session.id })
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

        let run: Awaited<ReturnType<typeof dispatchToWorker>>
        try {
          run = await dispatchToWorker({
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
          ctx.abort.removeEventListener("abort", cleanup)
          unsub()
        }

        // ── Unified proc-scan watchdog ────────────────────────────────
        // Replaces the old livenessTimer + disk-watchdog + no-progress
        // watchdog. Every 5s polls the worker's linux process for any
        // sign of activity:
        //   1. Process exit code → immediate terminate
        //   2. Disk terminal finish (past grace) → collect (worker done,
        //      bridge just didn't get the message out)
        //   3. CPU time / IO bytes / child processes — any tick = alive
        // If all three activity signals stay flat for 90s AND there is
        // no disk terminal finish, the worker is judged dead and killed.
        // Single 60s timeout. Watchdog polls every 5s. Any death signal
        // fires immediately, no warmup, no grace beyond the 5s disk-race
        // margin below.
        const WATCHDOG_INTERVAL_MS = 5_000
        const SILENCE_THRESHOLD_MS = 60_000
        // Tiny grace on disk-terminal-finish so the worker's stdout `done`
        // signal wins the race with the disk read when both arrive within
        // the same poll cycle.
        const DISK_GRACE_MS = 5_000
        const TERMINAL_FINISHES = ["stop", "error", "length", "canceled"]

        type ProcSample = {
          state: string // R/S/D/Z/T/X from /proc/<pid>/stat
          cpu: number
          readBytes: number
          writeBytes: number
          hasChildren: boolean
          wchan?: string // kernel function the process is blocked in, if any
        }
        async function readProcSample(pid: number): Promise<ProcSample | null> {
          try {
            const stat = await readFile(`/proc/${pid}/stat`, "utf-8")
            // Skip the first two fields (pid and `(comm)`); comm may contain spaces.
            const rp = stat.lastIndexOf(")")
            if (rp === -1) return null
            const tail = stat.slice(rp + 2).trim().split(/\s+/)
            // After comm: state(0) ppid(1) pgrp(2) session(3) tty_nr(4) tpgid(5)
            // flags(6) minflt(7) cminflt(8) majflt(9) cmajflt(10) utime(11) stime(12)
            const state = tail[0] ?? "?"
            const utime = Number(tail[11])
            const stime = Number(tail[12])
            const cpu = (Number.isFinite(utime) ? utime : 0) + (Number.isFinite(stime) ? stime : 0)
            let readBytes = 0
            let writeBytes = 0
            try {
              const io = await readFile(`/proc/${pid}/io`, "utf-8")
              for (const line of io.split("\n")) {
                const [k, v] = line.split(": ")
                if (k === "read_bytes") readBytes = Number(v) || 0
                if (k === "write_bytes") writeBytes = Number(v) || 0
              }
            } catch {
              // /proc/<pid>/io may be restricted; fall through
            }
            let hasChildren = false
            try {
              const tids = await readdir(`/proc/${pid}/task`)
              for (const tid of tids) {
                try {
                  const kids = await readFile(`/proc/${pid}/task/${tid}/children`, "utf-8")
                  if (kids.trim().length > 0) {
                    hasChildren = true
                    break
                  }
                } catch {
                  // ignore unreadable task
                }
              }
            } catch {
              // /proc/<pid>/task gone; treat as no children
            }
            let wchan: string | undefined
            try {
              const w = (await readFile(`/proc/${pid}/wchan`, "utf-8")).trim()
              if (w && w !== "0") wchan = w
            } catch {
              // wchan unreadable — diagnostic only, skip
            }
            return { state, cpu, readBytes, writeBytes, hasChildren, wchan }
          } catch {
            return null
          }
        }

        let watchdogTimer: ReturnType<typeof setInterval> | undefined
        const watchdogCompletion = new Promise<{
          resolution: "worker_dead" | "disk_terminal" | "silent_kill"
          ok: boolean
          finish: string
          wchan?: string
        }>((resolveWD) => {
          let prev: ProcSample | null = null
          let silentSinceMs: number | null = null
          watchdogTimer = setInterval(async () => {
            try {
              const worker = assignedWorkerID ? workers.find((w) => w.id === assignedWorkerID) : undefined
              if (!worker) return // worker not yet assigned; skip this tick

              // Touch supervisor so monitor UI knows we're polling.
              if (ctx.callID) ProcessSupervisor.touch(ctx.callID)

              // A. Disk terminal finish past 5s grace — child self-reported
              //    completion. Always honored regardless of proc signals.
              try {
                const { messages: childMsgs } = await MessageV2.filterCompacted(MessageV2.stream(session.id))
                const lastAssistant = childMsgs.findLast((m) => m.info.role === "assistant")
                if (lastAssistant) {
                  const info = lastAssistant.info as MessageV2.Assistant
                  if (info.finish && TERMINAL_FINISHES.includes(info.finish)) {
                    const completedAt = info.time?.completed
                    if (completedAt && Date.now() - completedAt >= DISK_GRACE_MS) {
                      Log.create({ service: "task" }).warn("proc-watchdog: disk terminal finish past grace", {
                        childSessionID: session.id,
                        workerID: assignedWorkerID,
                        finish: info.finish,
                        elapsedMs: Date.now() - completedAt,
                      })
                      resolveWD({
                        resolution: "disk_terminal",
                        ok: info.finish === "stop",
                        finish: info.finish,
                      })
                      return
                    }
                  }
                }
              } catch {
                // disk read failed — keep going, try again next tick
              }

              // B. Proc scan: process state + activity signals.
              const proc = worker.proc
              const sample = await readProcSample(proc.pid as number)

              // B1. Process state letter: Z (zombie) / X (dead) is direct
              //     death — faster than waiting for bun's exitCode to land.
              if (sample && (sample.state === "Z" || sample.state === "X")) {
                Log.create({ service: "task" }).warn("proc-watchdog: worker process state terminal", {
                  childSessionID: session.id,
                  workerID: assignedWorkerID,
                  state: sample.state,
                })
                resolveWD({ resolution: "worker_dead", ok: false, finish: "worker_exited" })
                return
              }

              // B2. Also honor bun's exitCode (catches cases where state
              //     polling missed the transition or /proc was unreadable).
              if (proc.exitCode !== null || proc.killed) {
                Log.create({ service: "task" }).warn("proc-watchdog: worker process exited", {
                  childSessionID: session.id,
                  workerID: assignedWorkerID,
                  exitCode: proc.exitCode,
                })
                if (ctx.callID) ProcessSupervisor.markStalled(ctx.callID)
                resolveWD({ resolution: "worker_dead", ok: false, finish: "worker_exited" })
                return
              }

              if (!sample) {
                // /proc gone — process likely vanished between checks; next
                // tick's exit-code path will handle it.
                return
              }

              // B3. Activity signals. Any one ticking = alive → reset silence.
              const tickedCpu = prev && sample.cpu !== prev.cpu
              const tickedIoRead = prev && sample.readBytes !== prev.readBytes
              const tickedIoWrite = prev && sample.writeBytes !== prev.writeBytes
              const alive = sample.hasChildren || tickedCpu || tickedIoRead || tickedIoWrite || !prev
              const lastWchan = sample.wchan
              prev = sample

              const now = Date.now()
              if (alive) {
                silentSinceMs = null
              } else {
                if (silentSinceMs === null) silentSinceMs = now
                const silentFor = now - silentSinceMs
                if (silentFor >= SILENCE_THRESHOLD_MS) {
                  Log.create({ service: "task" }).warn("proc-watchdog: worker silent past threshold — killing", {
                    childSessionID: session.id,
                    workerID: assignedWorkerID,
                    silentMs: silentFor,
                    wchan: lastWchan ?? "(unknown)",
                  })
                  resolveWD({
                    resolution: "silent_kill",
                    ok: false,
                    finish: "no_progress_timeout",
                    wchan: lastWchan,
                  })
                }
              }
            } catch {
              // Non-fatal — retry next interval
            }
          }, WATCHDOG_INTERVAL_MS)
        })

        let workerOk = true
        let workerError: string | undefined
        let completionSource: "worker" | "watchdog" = "worker"
        let watchdogResolution: "worker_dead" | "disk_terminal" | "silent_kill" | undefined
        try {
          const outcome = await Promise.race([
            run.done.then(() => ({ kind: "worker" as const })),
            watchdogCompletion.then((d) => ({ kind: "watchdog" as const, ...d })),
          ])
          if (outcome.kind === "worker") {
            completionSource = "worker"
            mark("worker_done_resolved")
          } else {
            completionSource = "watchdog"
            watchdogResolution = outcome.resolution
            workerOk = outcome.ok
            if (!outcome.ok) workerError = `child session finished with: ${outcome.finish}`
            mark("worker_done_watchdog_fallback", { resolution: outcome.resolution, ok: outcome.ok })
          }
        } catch (err) {
          workerOk = false
          workerError = err instanceof Error ? err.message : String(err)
          mark("worker_done_rejected", { error: workerError })
        } finally {
          if (watchdogTimer) clearInterval(watchdogTimer)
          await SessionActiveChild.set(ctx.sessionID, null).catch(() => undefined)
        }
        // Kill worker on disk_terminal (bridge stuck) or silent_kill (truly hung).
        // worker_dead path has an already-exited process; nothing to kill.
        if (completionSource === "watchdog" && watchdogResolution !== "worker_dead") {
          const worker = assignedWorkerID ? workers.find((w) => w.id === assignedWorkerID) : undefined
          if (worker) {
            Log.create({ service: "task" }).warn("proc-watchdog: killing worker", {
              childSessionID: session.id,
              workerID: assignedWorkerID,
              resolution: watchdogResolution,
            })
            try { worker.proc.kill() } catch { /* already dead */ }
          }
        }

        // Reconcile linked todo
        if (linkedTodo?.id) {
          await Todo.reconcileProgress({
            sessionID: ctx.sessionID,
            linkedTodoID: linkedTodo.id,
            taskStatus: workerOk ? "completed" : "error",
          }).catch(() => undefined)
        }

        // Extract child session output so parent LLM has the actual results
        let childOutput = ""
        if (workerOk) {
          try {
            const { messages: childMsgs } = await MessageV2.filterCompacted(MessageV2.stream(session.id))
            const assistantTexts: string[] = []
            for (const msg of childMsgs) {
              if (msg.info.role !== "assistant") continue
              for (const part of msg.parts) {
                if (part.type === "text" && part.text?.trim()) {
                  assistantTexts.push(part.text.trim())
                }
              }
            }
            if (assistantTexts.length > 0) {
              const recent = assistantTexts.slice(-3)
              childOutput = `\n\n<child_session_output session="${session.id}">\n${recent.join("\n\n---\n\n")}\n</child_session_output>`
            }
          } catch {
            // Non-fatal: parent continues without child output detail
          }

          // Fallback: if message history empty (e.g. compaction), use SharedContext
          if (!childOutput) {
            try {
              const childCtx = await SharedContext.get(session.id)
              if (childCtx) {
                const parts: string[] = []
                if (childCtx.currentState) parts.push(`State: ${childCtx.currentState}`)
                if (childCtx.actions.length > 0)
                  parts.push(`Actions:\n${childCtx.actions.map((a: any) => `- ${a.summary}`).join("\n")}`)
                if (childCtx.discoveries.length > 0)
                  parts.push(`Discoveries:\n${childCtx.discoveries.map((d: any) => `- ${d}`).join("\n")}`)
                if (childCtx.files.length > 0)
                  parts.push(`Files touched: ${childCtx.files.map((f: any) => f.path).join(", ")}`)
                if (parts.length > 0) {
                  childOutput = `\n\n<child_session_output session="${session.id}" source="shared_context">\n${parts.join("\n\n")}\n</child_session_output>`
                }
              }
            } catch {
              // Non-fatal
            }
          }
        }

        mark("finished", { ok: workerOk, error: workerError })

        return {
          title: params.description,
          output: workerOk
            ? `Subagent session ${session.id} completed successfully.${childOutput}`
            : `Subagent session ${session.id} failed: ${workerError ?? "unknown error"}`,
          metadata: {
            dispatched: true,
            subSessionID: session.id,
            linkedTodoID: linkedTodo?.id,
          },
        }
      } catch (error: unknown) {
        // Catch-all: if anything throws before/after await run.done,
        // still clear the floating bar so it doesn't stick.
        if (assignedWorkerID) {
          await SessionActiveChild.set(ctx.sessionID, null).catch(() => undefined)
        }
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
