import { Identifier } from "@/id/id"
import { Session } from "./index"
import { Todo } from "./todo"
import { MessageV2 } from "./message-v2"

export const AUTONOMOUS_CONTINUE_TEXT =
  "Continue with the next planned step. Only stop and ask the user if you hit a real blocker or need a product decision."

export type ContinuationDecisionReason =
  | "subagent_session"
  | "autonomous_disabled"
  | "blocked"
  | "max_continuous_rounds"
  | "todo_complete"
  | "todo_pending"

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

export async function enqueueAutonomousContinue(input: { sessionID: string; user: MessageV2.User; text?: string }) {
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
  return message
}
