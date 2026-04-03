import { Bus } from "../index"
import { SessionActiveChild, TaskWorkerEvent } from "@/tool/task"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Identifier } from "@/id/id"
import { Todo } from "@/session/todo"
import { ProcessSupervisor } from "@/process/supervisor"
import { enqueuePendingContinuation, resumePendingContinuations } from "@/session/workflow-runner"
import { Instance } from "@/project/instance"
import { SharedContext } from "@/session/shared-context"
import { Log } from "@/util/log"
import { describeTaskNarration, emitSessionNarration } from "@/session/narration"
import z from "zod"

const log = Log.create({ service: "task-worker-continuation" })

async function enqueueParentContinuation(input: {
  parentSessionID: string
  parentMessageID: string
  toolCallID: string
  childSessionID: string
  linkedTodoID?: string
  ok: boolean
  error?: string
}) {
  log.info("[TRACE][ENQUEUE_START] enqueueParentContinuation called", {
    parentSessionID: input.parentSessionID,
    parentMessageID: input.parentMessageID,
    toolCallID: input.toolCallID,
    childSessionID: input.childSessionID,
    ok: input.ok,
    error: input.error,
  })

  const clearActiveChild = async () => {
    log.info("[TRACE][CLEAR_ACTIVE_CHILD] calling SessionActiveChild.set(null)", { parentSessionID: input.parentSessionID })
    await SessionActiveChild.set(input.parentSessionID, null)
    log.info("[TRACE][CLEAR_ACTIVE_CHILD_DONE] SessionActiveChild.set(null) completed", { parentSessionID: input.parentSessionID })
  }

  const clearLogicalTask = () => {
    log.info("[TRACE][CLEAR_LOGICAL_TASK] ProcessSupervisor.kill called", { toolCallID: input.toolCallID })
    ProcessSupervisor.kill(input.toolCallID)
  }

  log.info("[TRACE][ENQUEUE_GET_PARENT] fetching parent session", { parentSessionID: input.parentSessionID })
  const parent = await Session.get(input.parentSessionID).catch(() => undefined)
  if (!parent) {
    log.error("[TRACE][ENQUEUE_EARLY_EXIT_1] parent session NOT FOUND — aborting without clearActiveChild", { parentSessionID: input.parentSessionID })
    clearLogicalTask()
    throw new Error(`task_completion_parent_missing:${input.parentSessionID}`)
  }
  log.info("[TRACE][ENQUEUE_PARENT_FOUND] parent session found", { parentSessionID: input.parentSessionID, hasParentID: !!parent.parentID })
  if (parent.parentID) {
    log.error("[TRACE][ENQUEUE_EARLY_EXIT_2] parent has parentID (nested) — aborting without clearActiveChild", { parentSessionID: input.parentSessionID, parentID: parent.parentID })
    clearLogicalTask()
    throw new Error(`task_completion_parent_nested_unsupported:${input.parentSessionID}`)
  }

  log.info("[TRACE][ENQUEUE_GET_MSG] fetching parent assistant message", { parentSessionID: input.parentSessionID, parentMessageID: input.parentMessageID })
  const assistant = await MessageV2.get({
    sessionID: input.parentSessionID,
    messageID: input.parentMessageID,
  }).catch(() => undefined)
  if (!assistant || assistant.info.role !== "assistant") {
    log.error("[TRACE][ENQUEUE_EARLY_EXIT_3] parent assistant message NOT FOUND or wrong role — aborting without clearActiveChild", { parentSessionID: input.parentSessionID, parentMessageID: input.parentMessageID, found: !!assistant, role: assistant?.info?.role })
    clearLogicalTask()
    throw new Error(`task_completion_parent_message_missing:${input.parentMessageID}`)
  }
  log.info("[TRACE][ENQUEUE_MSG_FOUND] parent message found", { parentMessageID: input.parentMessageID, role: assistant.info.role, parts: assistant.parts.length })

  const taskPart = assistant.parts.find(
    (part): part is MessageV2.ToolPart =>
      part.type === "tool" && part.callID === input.toolCallID && part.tool === "task",
  )
  log.info("[TRACE][ENQUEUE_FIND_TOOL_PART] searching for task tool part", { parentSessionID: input.parentSessionID, toolCallID: input.toolCallID, totalParts: assistant.parts.length, foundPart: !!taskPart, partTypes: assistant.parts.map((p: any) => ({ type: p.type, callID: (p as any).callID, tool: (p as any).tool })).slice(0, 10) })
  if (!taskPart) {
    log.error("[TRACE][ENQUEUE_EARLY_EXIT_4] task tool part NOT FOUND — aborting without clearActiveChild", { parentSessionID: input.parentSessionID, toolCallID: input.toolCallID, partCallIDs: assistant.parts.filter((p: any) => p.type === "tool").map((p: any) => (p as any).callID) })
    clearLogicalTask()
    throw new Error(`task_completion_tool_part_missing:${input.toolCallID}`)
  }
  log.info("[TRACE][ENQUEUE_TOOL_PART_FOUND] task tool part found", { toolCallID: input.toolCallID, partStatus: taskPart.state?.status })

  log.info("[TRACE][ENQUEUE_CLEAR_ACTIVE_CHILD] about to clear active child", { parentSessionID: input.parentSessionID })
  await clearActiveChild().catch(() => undefined)
  log.info("[TRACE][ENQUEUE_ACTIVE_CHILD_CLEARED] active child cleared", { parentSessionID: input.parentSessionID })

  // Fix: update tool part state from "running" to "completed"/"error" so sidebar monitor clears
  const partNow = Date.now()
  const startTime = taskPart.state.status === "running" ? taskPart.state.time.start : partNow
  log.info("updating task tool part state", {
    parentSessionID: input.parentSessionID,
    toolCallID: input.toolCallID,
    childSessionID: input.childSessionID,
    previousStatus: taskPart.state?.status,
    newStatus: input.ok ? "completed" : "error",
  })
  const completedState: z.infer<typeof MessageV2.ToolState> = input.ok
    ? {
        status: "completed" as const,
        input: taskPart.state.input,
        output: `Subagent ${input.childSessionID} completed successfully.`,
        title: taskPart.state.status === "running" ? (taskPart.state.title ?? "task") : "task",
        metadata: taskPart.state.status === "running" ? (taskPart.state.metadata ?? {}) : {},
        time: { start: startTime, end: partNow },
      }
    : {
        status: "error" as const,
        input: taskPart.state.input,
        error: input.error ?? `Subagent ${input.childSessionID} failed.`,
        time: { start: startTime, end: partNow },
      }
  await Session.updatePart({
    ...taskPart,
    state: completedState,
  }).catch((err) =>
    log.error("failed to update task tool part state", {
      parentSessionID: input.parentSessionID,
      toolCallID: input.toolCallID,
      error: String(err),
    }),
  )

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

  await emitSessionNarration({
    sessionID: input.parentSessionID,
    parentID: assistant.info.parentID,
    agent: assistant.info.agent,
    variant: assistant.info.variant,
    model: resumedModel,
    text: describeTaskNarration(
      input.ok
        ? { phase: "complete", title: "title" in completedState ? completedState.title : "task", output: "output" in completedState ? completedState.output : "" }
        : { phase: "error", error: "error" in completedState ? completedState.error : "Unknown error" }
    ),
    kind: "task",
    metadata: {
      taskNarration: true,
      taskPhase: input.ok ? "complete" : "error",
      toolCallId: input.toolCallID,
    },
  }).catch((err) =>
    log.error("failed to emit session narration", {
      parentSessionID: input.parentSessionID,
      error: String(err),
    }),
  )

  try {
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

    // Context Sharing v2: child's full message history is already visible to parent
    // via prompt.ts parent message prefix. We extract a concise summary of child's
    // key outputs for the continuation message, so parent LLM has immediate awareness.
    let childSummary: string | undefined
    if (input.ok) {
      try {
        const { messages: childMsgs } = await MessageV2.filterCompacted(MessageV2.stream(input.childSessionID))
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
          // Take last few assistant outputs (most relevant) — keep within ~4K tokens
          const recent = assistantTexts.slice(-3)
          childSummary = `<child_session_output session="${input.childSessionID}">\n${recent.join("\n\n---\n\n")}\n</child_session_output>`
        }
      } catch {
        // Non-fatal: parent continues without child summary
      }

      // Merge child's SharedContext into parent's Space (retained for compaction/observability)
      await SharedContext.mergeFrom({
        targetSessionID: input.parentSessionID,
        sourceSessionID: input.childSessionID,
      }).catch(() => undefined)

      // Fallback: if message history was destroyed by compaction loops (e.g. weak model
      // compacting repeatedly), use SharedContext snapshot as evidence so parent LLM
      // has something actionable instead of an empty completion notice.
      if (!childSummary) {
        try {
          const childCtx = await SharedContext.get(input.childSessionID)
          if (childCtx) {
            const parts: string[] = []
            if (childCtx.currentState) parts.push(`State: ${childCtx.currentState}`)
            if (childCtx.actions.length > 0)
              parts.push(`Actions:\n${childCtx.actions.map((a) => `- ${a.summary}`).join("\n")}`)
            if (childCtx.discoveries.length > 0)
              parts.push(`Discoveries:\n${childCtx.discoveries.map((d) => `- ${d}`).join("\n")}`)
            if (childCtx.files.length > 0)
              parts.push(`Files touched: ${childCtx.files.map((f) => f.path).join(", ")}`)
            if (parts.length > 0) {
              childSummary = `<child_session_output session="${input.childSessionID}" source="shared_context">\n${parts.join("\n\n")}\n</child_session_output>`
              log.warn("child message history empty after compaction, using SharedContext fallback", {
                childSessionID: input.childSessionID,
                parentSessionID: input.parentSessionID,
                contextParts: parts.length,
              })
            }
          }
        } catch {
          // Non-fatal: proceed without fallback
        }
      }
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

    const continuationText = input.ok
      ? [
          childSummary ? `${childSummary}\n\n---\n\n` : "",
          `Subagent ${input.childSessionID} completed.`,
          childSummary
            ? " Continue immediately with the next step based on the evidence above."
            : " The subagent's detailed output was lost due to context compaction. Check SharedContext and the child session for details, then continue with the next step.",
        ].join("")
      : `Subagent ${input.childSessionID} failed. Continue immediately using the recorded task error and child session evidence: ${input.error ?? "unknown error"}`

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID,
      sessionID: input.parentSessionID,
      type: "text",
      text: continuationText,
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

    log.info("DEBUG_RCA_STALL_SCAN: step 6: enqueuing parent continuation", {
      parentSessionID: input.parentSessionID,
      messageID,
      isOk: input.ok,
    })

    log.info("[TRACE][ENQUEUE_BEFORE_ENQUEUE] calling enqueuePendingContinuation", {
      parentSessionID: input.parentSessionID,
      messageID,
      isOk: input.ok,
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

    log.info("DEBUG_RCA_STALL_SCAN: step 7: parent continuation enqueued", { parentSessionID: input.parentSessionID })

    await Session.setWorkflowState({
      sessionID: input.parentSessionID,
      state: "idle",
      stopReason: undefined,
      lastRunAt: now,
    }).catch(() => undefined)

    log.info("triggering resumePendingContinuations", {
      parentSessionID: input.parentSessionID,
      childSessionID: input.childSessionID,
      ok: input.ok,
    })
    await resumePendingContinuations({ maxCount: 1, preferredSessionID: input.parentSessionID }).catch((err) => {
      log.error("resumePendingContinuations failed", {
        parentSessionID: input.parentSessionID,
        childSessionID: input.childSessionID,
        error: String(err),
      })
    })
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
    clearLogicalTask()
  }
}

let registered = false

export function registerTaskWorkerContinuationSubscriber() {
  if (registered) return
  registered = true

  Bus.subscribeGlobal(TaskWorkerEvent.Done.type, 0, async (event) => {
    log.info("[TRACE][SUBSCRIBER_DONE_FIRED] TaskWorkerEvent.Done subscriber fired", {
      workerID: event.properties.workerID,
      sessionID: event.properties.sessionID,
      parentSessionID: event.properties.parentSessionID,
      parentMessageID: event.properties.parentMessageID,
      toolCallID: event.properties.toolCallID,
      hasDirectory: !!event.context?.directory,
      directory: event.context?.directory,
    })
    // In daemon mode the Bus subscriber fires outside the original HTTP request's
    // Instance.provide() scope.  Re-establish the project context so Session.get(),
    // MessageV2.get(), etc. resolve to the correct storage.
    const directory = event.context?.directory
    const run = () =>
      enqueueParentContinuation({
        parentSessionID: event.properties.parentSessionID,
        parentMessageID: event.properties.parentMessageID,
        toolCallID: event.properties.toolCallID,
        childSessionID: event.properties.sessionID,
        linkedTodoID: event.properties.linkedTodoID,
        ok: true,
      })
    const result = directory ? Instance.provide({ directory, fn: run }) : run()
    await result.catch((err) =>
      log.error("enqueueParentContinuation failed (Done)", {
        parentSessionID: event.properties.parentSessionID,
        error: String(err),
      }),
    )
  })

  Bus.subscribeGlobal(TaskWorkerEvent.Failed.type, 0, async (event) => {
    log.info("TaskWorkerEvent.Failed received", {
      workerID: event.properties.workerID,
      sessionID: event.properties.sessionID,
      parentSessionID: event.properties.parentSessionID,
      toolCallID: event.properties.toolCallID,
      error: event.properties.error,
    })
    const directory = event.context?.directory
    const run = () =>
      enqueueParentContinuation({
        parentSessionID: event.properties.parentSessionID,
        parentMessageID: event.properties.parentMessageID,
        toolCallID: event.properties.toolCallID,
        childSessionID: event.properties.sessionID,
        linkedTodoID: event.properties.linkedTodoID,
        ok: false,
        error: event.properties.error,
      })
    const result = directory ? Instance.provide({ directory, fn: run }) : run()
    await result.catch((err) =>
      log.error("enqueueParentContinuation failed (Failed)", {
        parentSessionID: event.properties.parentSessionID,
        error: String(err),
      }),
    )
  })
}
