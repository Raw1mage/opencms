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

// NOTE: @event_task_tool_complex_input
// Updated schema to support both simple string and complex structured input.
// This allows passing additional metadata and task configuration alongside the prompt.
// The prompt can be:
// - A simple string: "Write unit tests for auth module"
// - A JSON object: { "type": "testing", "content": "...", "metadata": { "priority": "high" } }
const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  // Support both simple text and complex structured input
  // TODO #3: Enhanced to accept union type for flexibility
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
  model: z.string().describe("Optional model ID to use for this task (e.g. 'openai/gpt-5.1-codex-mini')").optional(),
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
    return ["read", "glob", "grep", "list", "bash", "webfetch", "websearch", "codesearch", "question"]
  }
  if (name === "review" || name === "testing" || name === "docs") {
    return ["read", "glob", "grep", "list", "bash", "webfetch", "websearch", "codesearch", "question"]
  }
  if (name === "coding") {
    return ["read", "glob", "grep", "list", "bash", "edit", "write", "apply_patch", "question"]
  }
  return undefined
}

const BRIDGE_PREFIX = "__OPENCODE_BRIDGE_EVENT__ "
const WORKER_PREFIX = "__OPENCODE_WORKER__ "
const WORKER_READY_TIMEOUT_MS = 15_000

async function publishBridgedEvent(event: { type: string; properties: any }) {
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
  resolve: () => void
  reject: (error: Error) => void
}

type TaskWorker = {
  id: string
  proc: Bun.Subprocess
  busy: boolean
  ready: boolean
  readyPromise: Promise<void>
  readyResolve: () => void
  current?: WorkerRequest
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
  if (index >= 0) workers.splice(index, 1)
}

function spawnWorker(config: Awaited<ReturnType<typeof Config.get>>) {
  const workerID = `task-worker-${++workerSeq}`
  const proc = Bun.spawn(buildWorkerCmd(), {
    env: {
      ...process.env,
      OPENCODE_NON_INTERACTIVE: "1",
      OPENCODE_TASK_EVENT_BRIDGE: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  })

  let readyResolve = () => { }
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
  }
  workers.push(worker)

  ProcessSupervisor.register({
    id: workerID,
    kind: "task-subagent",
    process: proc,
  })

  const log = Log.create({ service: "task.worker" })
  ; (async () => {
    const reader = proc.stdout?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buffer = ""
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
          const payload = line.slice(BRIDGE_PREFIX.length)
          try {
            const event = JSON.parse(payload)
            void publishBridgedEvent(event).catch(() => { })
          } catch {
            // ignore invalid bridge payload
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
          worker.ready = true
          worker.readyResolve()
          continue
        }

        if (msg?.type === "done" && worker.current?.id === msg.id) {
          const req = worker.current
          worker.current = undefined
          worker.busy = false
          if (msg.ok) req.resolve()
          else req.reject(new Error(msg.error || "worker run failed"))
          void ensureStandbyWorker(config)
        }
      }
    }

    if (!worker.ready) worker.readyResolve()
    const req = worker.current
    worker.current = undefined
    worker.busy = false
    removeWorker(worker.id)
    if (req) req.reject(new Error("worker process exited unexpectedly"))
    log.debug("task worker exited", { workerID, exitCode: await proc.exited.catch(() => -1) })
  })().catch(() => {
    removeWorker(worker.id)
    if (!worker.ready) worker.readyResolve()
    if (worker.current) worker.current.reject(new Error("worker stream failed"))
  })

  return worker
}

async function getReadyWorker(config: Awaited<ReturnType<typeof Config.get>>) {
  const idleReady = workers.find((w) => !w.busy && w.ready)
  if (idleReady) return idleReady

  const existing = workers.find((w) => !w.busy)
  if (existing) {
    await Promise.race([existing.readyPromise, Bun.sleep(WORKER_READY_TIMEOUT_MS)])
    if (existing.ready) return existing
  }

  const worker = spawnWorker(config)
  await Promise.race([worker.readyPromise, Bun.sleep(WORKER_READY_TIMEOUT_MS)])
  if (!worker.ready) throw new Error("subagent worker failed to become ready")
  return worker
}

async function ensureStandbyWorker(config: Awaited<ReturnType<typeof Config.get>>) {
  if (workers.some((w) => !w.busy && w.ready)) return
  if (standbySpawn) return standbySpawn
  standbySpawn = (async () => {
    try {
      const worker = spawnWorker(config)
      await Promise.race([worker.readyPromise, Bun.sleep(WORKER_READY_TIMEOUT_MS)])
      if (!worker.ready) {
        ProcessSupervisor.kill(worker.id)
        removeWorker(worker.id)
      }
    } finally {
      standbySpawn = undefined
    }
  })()
  return standbySpawn
}

async function dispatchToWorker(
  input: {
    sessionID: string
    config: Awaited<ReturnType<typeof Config.get>>
    abort: AbortSignal
  },
) {
  const worker = await getReadyWorker(input.config)
  worker.busy = true
  void ensureStandbyWorker(input.config)

  const requestID = Identifier.ascending("message")
  const done = new Promise<void>((resolve, reject) => {
    worker.current = {
      id: requestID,
      sessionID: input.sessionID,
      resolve,
      reject,
    }
  })

  worker.proc.stdin?.write(
    JSON.stringify({
      type: "run",
      id: requestID,
      sessionID: input.sessionID,
    }) + "\n",
  )

  const onAbort = () => {
    try {
      worker.proc.stdin?.write(
        JSON.stringify({
          type: "cancel",
          id: requestID,
          sessionID: input.sessionID,
        }) + "\n",
      )
    } catch {
      // ignore
    }
  }
  input.abort.addEventListener("abort", onAbort)
  try {
    await done
  } finally {
    input.abort.removeEventListener("abort", onAbort)
  }
}

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

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
      debugCheckpoint("task", "Task tool execute started", {
        description: params.description,
        subagent_type: params.subagent_type,
        model_param: params.model,
        session_id: params.session_id,
      })

      const config = await Config.get()

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

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
      debugCheckpoint("task", "Agent loaded", { agentName: agent.name, agentModel: agent.model })

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
      const toolWhitelist = toolWhitelistForSubagent(agent.name)

      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id).catch(() => { })
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
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const modelArg = params.model ? Provider.parseModel(params.model) : undefined
      const model = modelArg ??
        agent.model ?? {
        modelID: msg.info.modelID,
        providerId: msg.info.providerId,
      }

      debugCheckpoint("task", "Model resolved for subagent", {
        modelArg,
        agentModel: agent.model,
        parentModel: { modelID: msg.info.modelID, providerId: msg.info.providerId },
        finalModel: model,
      })

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
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

      // Default timeout: 10 minutes per subagent execution
      // This prevents zombie processes that hang indefinitely
      const SUBAGENT_TIMEOUT_MS = config.experimental?.task_timeout ?? 10 * 60 * 1000

      // Activity tracking: sample child session state from storage.
      // Child process events are not available via the in-process bus.
      let lastActivityTime = Date.now()
      let lastSignature = ""
      const ACTIVITY_POLL_INTERVAL_MS = 2_000
      const sampleChildActivity = async () => {
        const messages = await Session.messages({ sessionID: session.id })
        const last = messages.at(-1)?.info
        const signature = `${messages.length}:${last?.id ?? ""}:${last?.time.completed ?? last?.time.created ?? 0}`
        if (signature !== lastSignature) {
          lastSignature = signature
          lastActivityTime = Date.now()
          if (ctx.callID) ProcessSupervisor.touch(ctx.callID)
        }
      }
      await sampleChildActivity()
      const activityPoll = setInterval(() => {
        void sampleChildActivity().catch((error) => {
          Log.create({ service: "task" }).debug("Failed to poll subagent activity", {
            callID: ctx.callID,
            sessionID: session.id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }, ACTIVITY_POLL_INTERVAL_MS)

      // Heartbeat check: if no activity for too long, process may be zombified
      const HEARTBEAT_INTERVAL_MS = 30_000 // Check every 30 seconds
      const HEARTBEAT_STALE_MS = 120_000 // Consider stale after 2 minutes of no activity

      const heartbeatTimer = setInterval(() => {
        const staleDuration = Date.now() - lastActivityTime
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
        // Race between process exit and timeout
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), SUBAGENT_TIMEOUT_MS)
        })

        const result = await Promise.race([
          dispatchToWorker({
            sessionID: session.id,
            config,
            abort: ctx.abort,
          }).then(() => ({ type: "done" as const })),
          timeoutPromise,
        ])

        if (result === "timeout") {
          Log.create({ service: "task" }).error("Subagent execution timed out, killing process", {
            callID: ctx.callID,
            sessionID: session.id,
            timeoutMs: SUBAGENT_TIMEOUT_MS,
          })
          SessionPrompt.cancel(session.id)
          throw new Error(`Subagent execution timed out after ${SUBAGENT_TIMEOUT_MS / 1000} seconds`)
        }
      } finally {
        clearInterval(activityPoll)
        clearInterval(heartbeatTimer)
        ctx.abort.removeEventListener("abort", cleanup)
        unsub()
        if (ctx.callID) ProcessSupervisor.kill(ctx.callID)
      }

      // Read the result from the session logs
      const messages = await Session.messages({ sessionID: session.id })
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

      return {
        title: params.description,
        metadata: {
          summary,
          sessionId: session.id,
          model,
        },
        output,
      }
    },
  }
})
