import { Bus } from "../index"
import { SessionActiveChild, TaskWorkerEvent } from "@/tool/task"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Identifier } from "@/id/id"
import { Todo } from "@/session/todo"
import { ProcessSupervisor } from "@/process/supervisor"
import { enqueuePendingContinuation, resumePendingContinuations } from "@/session/workflow-runner"
import { SessionStatus } from "@/session/status"

async function enqueueParentContinuation(input: {
  parentSessionID: string
  parentMessageID: string
  toolCallID: string
  childSessionID: string
  linkedTodoID?: string
  ok: boolean
  error?: string
}) {
  const markActiveChildHandoff = async () => {
    const parentAssistant = await MessageV2.get({
      sessionID: input.parentSessionID,
      messageID: input.parentMessageID,
    }).catch(() => undefined)
    const taskPart = parentAssistant?.parts.find(
      (part): part is MessageV2.ToolPart =>
        part.type === "tool" && part.callID === input.toolCallID && part.tool === "task",
    )
    const metadata = taskPart?.metadata as
      | {
          sessionId?: string
          todo?: { id: string; content: string; status: string; action?: unknown }
          agent?: string
        }
      | undefined
    await SessionActiveChild.set(input.parentSessionID, {
      sessionID: input.childSessionID,
      parentMessageID: input.parentMessageID,
      toolCallID: input.toolCallID,
      workerID: "handoff",
      title: taskPart?.state.input?.description ?? taskPart?.state.title ?? metadata?.todo?.content ?? "Subtask",
      agent: metadata?.agent ?? "task",
      status: "handoff",
      todo: metadata?.todo,
    })
  }

  const clearActiveChild = async () => {
    await SessionActiveChild.set(input.parentSessionID, null)
  }

  const clearLogicalTask = () => {
    ProcessSupervisor.kill(input.toolCallID)
  }

  const parent = await Session.get(input.parentSessionID).catch(() => undefined)
  if (!parent) {
    clearLogicalTask()
    throw new Error(`task_completion_parent_missing:${input.parentSessionID}`)
  }
  if (parent.parentID) {
    clearLogicalTask()
    throw new Error(`task_completion_parent_nested_unsupported:${input.parentSessionID}`)
  }

  const assistant = await MessageV2.get({
    sessionID: input.parentSessionID,
    messageID: input.parentMessageID,
  }).catch(() => undefined)
  if (!assistant || assistant.info.role !== "assistant") {
    clearLogicalTask()
    throw new Error(`task_completion_parent_message_missing:${input.parentMessageID}`)
  }

  const taskPart = assistant.parts.find(
    (part): part is MessageV2.ToolPart =>
      part.type === "tool" && part.callID === input.toolCallID && part.tool === "task",
  )
  if (!taskPart) {
    clearLogicalTask()
    throw new Error(`task_completion_tool_part_missing:${input.toolCallID}`)
  }

  try {
    await markActiveChildHandoff().catch(() => undefined)
    if (input.linkedTodoID) {
      await Todo.reconcileProgress({
        sessionID: input.parentSessionID,
        linkedTodoID: input.linkedTodoID,
        taskStatus: input.ok ? "completed" : "error",
      })
    }

    const now = Date.now()
    const messageID = Identifier.ascending("message")
    const resumedModel = parent.execution
      ? {
          providerId: parent.execution.providerId,
          modelID: parent.execution.modelID,
          accountId: parent.execution.accountId,
        }
      : {
          providerId: assistant.info.providerId,
          modelID: assistant.info.modelID,
          accountId: "accountId" in assistant.info ? assistant.info.accountId : undefined,
        }

    await Session.updateMessage({
      id: messageID,
      role: "user",
      sessionID: input.parentSessionID,
      time: { created: now },
      agent: assistant.info.agent,
      model: resumedModel,
      format: undefined,
      variant: assistant.info.variant,
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID,
      sessionID: input.parentSessionID,
      type: "text",
      text: input.ok
        ? `Subagent ${input.childSessionID} completed. Continue immediately using the recorded task result and child session evidence.`
        : `Subagent ${input.childSessionID} failed. Continue immediately using the recorded task error and child session evidence: ${input.error ?? "unknown error"}`,
      synthetic: true,
      time: { start: now, end: now },
      metadata: {
        taskCompletion: {
          childSessionID: input.childSessionID,
          toolCallID: input.toolCallID,
          ok: input.ok,
          error: input.error,
        },
      },
    })

    await enqueuePendingContinuation({
      sessionID: input.parentSessionID,
      messageID,
      createdAt: now,
      roundCount: 0,
      reason: "todo_pending",
      text: input.ok
        ? `Task completed for child session ${input.childSessionID}. Continue the parent orchestration from the completion evidence already stored in-session.`
        : `Task failed for child session ${input.childSessionID}: ${input.error ?? "unknown error"}. Continue the parent orchestration from the failure evidence already stored in-session.`,
      triggerType: input.ok ? "task_completion" : "task_failure",
    })

    await Session.setWorkflowState({
      sessionID: input.parentSessionID,
      state: "idle",
      stopReason: undefined,
      lastRunAt: now,
    }).catch(() => undefined)

    await resumePendingContinuations({ maxCount: 1, preferredSessionID: input.parentSessionID }).catch(() => undefined)
  } catch (error) {
    if (input.linkedTodoID) {
      await Todo.reconcileProgress({
        sessionID: input.parentSessionID,
        linkedTodoID: input.linkedTodoID,
        taskStatus: "error",
      }).catch(() => undefined)
    }
    throw error
  } finally {
    if (SessionActiveChild.get(input.parentSessionID)?.status !== "handoff") {
      await clearActiveChild().catch(() => undefined)
    }
    clearLogicalTask()
  }
}

let registered = false

export function registerTaskWorkerContinuationSubscriber() {
  if (registered) return
  registered = true

  Bus.subscribeGlobal(SessionStatus.Event.Status.type, 0, async (event) => {
    if (event.properties.status.type !== "busy") return
    const activeChild = SessionActiveChild.get(event.properties.sessionID)
    if (!activeChild || activeChild.status !== "handoff") return
    await SessionActiveChild.set(event.properties.sessionID, null)
  })

  Bus.subscribeGlobal(TaskWorkerEvent.Done.type, 0, async (event) => {
    await enqueueParentContinuation({
      parentSessionID: event.properties.parentSessionID,
      parentMessageID: event.properties.parentMessageID,
      toolCallID: event.properties.toolCallID,
      childSessionID: event.properties.sessionID,
      linkedTodoID: event.properties.linkedTodoID,
      ok: true,
    })
  })

  Bus.subscribeGlobal(TaskWorkerEvent.Failed.type, 0, async (event) => {
    await enqueueParentContinuation({
      parentSessionID: event.properties.parentSessionID,
      parentMessageID: event.properties.parentMessageID,
      toolCallID: event.properties.toolCallID,
      childSessionID: event.properties.sessionID,
      linkedTodoID: event.properties.linkedTodoID,
      ok: false,
      error: event.properties.error,
    })
  })
}
