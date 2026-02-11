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

// Explicit Process Management for Subagents
// @class TaskProcessManager
// Responsible for tracking and cleaning up ephemeral subagent processes.
export namespace TaskProcessManager {
  const log = Log.create({ service: "task.process" })
  const active = new Map<string, Bun.Subprocess>()

  export function register(id: string, proc: Bun.Subprocess) {
    if (active.has(id)) {
      log.warn("Overwriting existing process for task", { id })
      kill(id)
    }
    active.set(id, proc)
    log.debug("Registered subagent process", { id, pid: proc.pid })

    // Self-cleanup on exit
    proc.exited.finally(() => {
      if (active.get(id) === proc) {
        active.delete(id)
        log.debug("Unregistered subagent process (exited)", { id, pid: proc.pid })
      }
    })
  }

  export function kill(id: string) {
    const proc = active.get(id)
    if (proc) {
      log.info("Killing subagent process", { id, pid: proc.pid })
      try {
        proc.kill()
      } catch (e) {
        log.error("Failed to kill process", { id, error: e })
      }
      active.delete(id)
    }
  }

  export async function disposeAll() {
    if (active.size === 0) return
    log.info("Disposing all subagent processes", { count: active.size })
    for (const [id, proc] of active) {
      try {
        proc.kill()
      } catch (e) {
        log.error("Failed to kill process during disposeAll", { id, error: e })
      }
    }
    active.clear()
  }
}

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

      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id).catch(() => { })
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: createSubsessionTitle(params, agent.name),
          permission: [
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

      // Execute the session loop in a separate process
      // This ensures that the subagent lifecycle is isolated and ends when it needs interaction
      const scriptPath = process.argv[1]
      const isBun = process.argv[0].endsWith("bun")

      // Determine the command to run
      // In dev: bun run src/index.ts session step <id>
      // In prod: opencode session step <id>
      const cmd = isBun && scriptPath.endsWith(".ts")
        ? [process.argv[0], "run", scriptPath, "session", "step", session.id]
        : [process.argv[0], "session", "step", session.id]

      debugCheckpoint("task", "Spawning subagent process", { cmd })

      const proc = Bun.spawn(cmd, {
        env: {
          ...process.env,
          // Ensure subagent inherits environment but knows it's non-interactive if needed
          OPENCODE_NON_INTERACTIVE: "1"
        },
        stdout: "inherit",
        stderr: "inherit"
      })

      // Register process for explicit management
      TaskProcessManager.register(ctx.callID, proc)

      // Link abort signal to process kill via Manager
      const cleanup = () => {
        TaskProcessManager.kill(ctx.callID)
      }
      ctx.abort.addEventListener("abort", cleanup)

      // Default timeout: 10 minutes per subagent execution
      // This prevents zombie processes that hang indefinitely
      const SUBAGENT_TIMEOUT_MS = config.experimental?.task_timeout ?? 10 * 60 * 1000

      // Activity tracking: monitor session updates to detect stalled processes
      let lastActivityTime = Date.now()
      const activityUnsub = Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
        if (evt.properties.part.sessionID === session.id) {
          lastActivityTime = Date.now()
        }
      })

      // Heartbeat check: if no activity for too long, process may be zombified
      const HEARTBEAT_INTERVAL_MS = 30_000 // Check every 30 seconds
      const HEARTBEAT_STALE_MS = 120_000 // Consider stale after 2 minutes of no activity

      const heartbeatTimer = setInterval(() => {
        const staleDuration = Date.now() - lastActivityTime
        if (staleDuration > HEARTBEAT_STALE_MS) {
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
          proc.exited.then(() => "exited" as const),
          timeoutPromise,
        ])

        if (result === "timeout") {
          Log.create({ service: "task" }).error("Subagent execution timed out, killing process", {
            callID: ctx.callID,
            sessionID: session.id,
            timeoutMs: SUBAGENT_TIMEOUT_MS,
          })
          TaskProcessManager.kill(ctx.callID)
          throw new Error(`Subagent execution timed out after ${SUBAGENT_TIMEOUT_MS / 1000} seconds`)
        }
      } finally {
        clearInterval(heartbeatTimer)
        activityUnsub()
        ctx.abort.removeEventListener("abort", cleanup)
        unsub()
      }

      // Read the result from the session logs
      const messages = await Session.messages({ sessionID: session.id })
      const lastMessage = messages.at(-1)

      if (!lastMessage) {
        throw new Error("Subagent execution completed with no messages")
      }

      // If the last message is from the assistant, returns its text as the output
      // If the subagent crashed or failed, we might see an error event in logs, but here we check message history
      const text = lastMessage.parts.findLast((x) => x.type === "text")?.text ?? ""

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
