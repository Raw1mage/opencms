import { Identifier } from "@/id/id"
import { Session } from "./index"
import { Todo } from "./todo"
import { MessageV2 } from "./message-v2"
import { Storage } from "@/storage/storage"
import z from "zod"
import { SessionStatus } from "./status"
import { Lock } from "@/util/lock"

export const AUTONOMOUS_CONTINUE_TEXT =
  "Continue with the next planned step. Only stop and ask the user if you hit a real blocker or need a product decision."

export type ContinuationDecisionReason =
  | "subagent_session"
  | "autonomous_disabled"
  | "blocked"
  | "max_continuous_rounds"
  | "todo_complete"
  | "todo_pending"

export const PendingContinuationInfo = z.object({
  sessionID: Identifier.schema("session"),
  messageID: Identifier.schema("message"),
  createdAt: z.number(),
  roundCount: z.number(),
  reason: z.enum(["todo_pending"]),
  text: z.string(),
})
export type PendingContinuationInfo = z.infer<typeof PendingContinuationInfo>

const RESUME_LOCK = "session.workflow.resume"
const resumeInFlight = new Set<string>()
let supervisorStarted = false
let supervisorTimer: ReturnType<typeof setInterval> | undefined

export function shouldResumePendingContinuation(input: {
  session: Pick<Session.Info, "workflow">
  status: SessionStatus.Info
  inFlight: boolean
}) {
  if (input.inFlight) return false
  if (input.status.type !== "idle") return false
  const workflow = input.session.workflow
  if (!workflow?.autonomous.enabled) return false
  if (workflow.state === "blocked" || workflow.state === "completed") return false
  return true
}

export function evaluateAutonomousContinuation(input: {
  session: Pick<Session.Info, "parentID" | "workflow" | "time">
  todos: Todo.Info[]
  roundCount: number
}) {
  const workflow = input.session.workflow ?? Session.defaultWorkflow(input.session.time.updated)
  if (input.session.parentID) {
    return { continue: false as const, reason: "subagent_session" as ContinuationDecisionReason }
  }
  if (!workflow.autonomous.enabled) {
    return { continue: false as const, reason: "autonomous_disabled" as ContinuationDecisionReason }
  }
  if (workflow.state === "blocked") {
    return { continue: false as const, reason: "blocked" as ContinuationDecisionReason }
  }
  const maxRounds = workflow.autonomous.maxContinuousRounds
  if (typeof maxRounds === "number" && input.roundCount >= maxRounds) {
    return { continue: false as const, reason: "max_continuous_rounds" as ContinuationDecisionReason }
  }
  const actionable = input.todos.some((todo) => todo.status === "pending" || todo.status === "in_progress")
  if (!actionable) {
    return { continue: false as const, reason: "todo_complete" as ContinuationDecisionReason }
  }
  return { continue: true as const, reason: "todo_pending" as ContinuationDecisionReason }
}

export async function decideAutonomousContinuation(input: { sessionID: string; roundCount: number }) {
  const session = await Session.get(input.sessionID)
  const todos = await Todo.get(input.sessionID)
  return evaluateAutonomousContinuation({
    session,
    todos,
    roundCount: input.roundCount,
  })
}

function queueKey(sessionID: string) {
  return ["session_workflow_queue", sessionID]
}

export async function getPendingContinuation(sessionID: string) {
  return Storage.read<PendingContinuationInfo>(queueKey(sessionID)).catch(() => undefined)
}

export async function clearPendingContinuation(sessionID: string) {
  await Storage.remove(queueKey(sessionID)).catch(() => undefined)
}

export async function listPendingContinuations() {
  const result: PendingContinuationInfo[] = []
  for (const item of await Storage.list(["session_workflow_queue"])) {
    const entry = await Storage.read<PendingContinuationInfo>(item).catch(() => undefined)
    if (entry) result.push(entry)
  }
  return result.sort((a, b) => a.createdAt - b.createdAt)
}

export async function enqueuePendingContinuation(input: PendingContinuationInfo) {
  await Storage.write(queueKey(input.sessionID), PendingContinuationInfo.parse(input))
}

export async function resumePendingContinuations() {
  using _lock = await Lock.write(RESUME_LOCK)
  const items = await listPendingContinuations()
  for (const item of items) {
    if (resumeInFlight.has(item.sessionID)) continue
    const session = await Session.get(item.sessionID).catch(() => undefined)
    if (!session) {
      await clearPendingContinuation(item.sessionID)
      continue
    }
    if (
      !shouldResumePendingContinuation({
        session,
        status: SessionStatus.get(item.sessionID),
        inFlight: resumeInFlight.has(item.sessionID),
      })
    ) {
      continue
    }

    resumeInFlight.add(item.sessionID)
    void (async () => {
      try {
        const { SessionPrompt } = await import("./prompt")
        await SessionPrompt.loop(item.sessionID)
      } catch (error) {
        await clearPendingContinuation(item.sessionID)
        await Session.setWorkflowState({
          sessionID: item.sessionID,
          state: "blocked",
          stopReason: `resume_failed:${error instanceof Error ? error.message : String(error)}`,
          lastRunAt: Date.now(),
        }).catch(() => undefined)
      } finally {
        resumeInFlight.delete(item.sessionID)
      }
    })()
  }
}

export function ensureAutonomousSupervisor(input?: { intervalMs?: number }) {
  if (supervisorStarted) return supervisorTimer
  supervisorStarted = true
  const intervalMs = input?.intervalMs ?? 5_000
  void resumePendingContinuations()
  supervisorTimer = setInterval(() => {
    void resumePendingContinuations()
  }, intervalMs)
  return supervisorTimer
}

export async function enqueueAutonomousContinue(input: {
  sessionID: string
  user: MessageV2.User
  text?: string
  roundCount?: number
}) {
  const now = Date.now()
  const message = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: input.sessionID,
    time: { created: now },
    agent: input.user.agent,
    model: input.user.model,
    format: input.user.format,
    variant: input.user.variant,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID: input.sessionID,
    type: "text",
    text: input.text ?? AUTONOMOUS_CONTINUE_TEXT,
    synthetic: true,
    time: {
      start: now,
      end: now,
    },
  })
  await enqueuePendingContinuation({
    sessionID: input.sessionID,
    messageID: message.id,
    createdAt: now,
    roundCount: input.roundCount ?? 0,
    reason: "todo_pending",
    text: input.text ?? AUTONOMOUS_CONTINUE_TEXT,
  })
  return message
}
