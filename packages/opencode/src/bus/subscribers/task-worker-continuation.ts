import { Bus } from "../index"
import { SessionActiveChild, TaskWorkerEvent } from "@/tool/task"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { ProcessSupervisor } from "@/process/supervisor"
import { Instance } from "@/project/instance"
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
    log.info("[TRACE][CLEAR_ACTIVE_CHILD] calling SessionActiveChild.set(null)", {
      parentSessionID: input.parentSessionID,
    })
    await SessionActiveChild.set(input.parentSessionID, null)
    log.info("[TRACE][CLEAR_ACTIVE_CHILD_DONE] SessionActiveChild.set(null) completed", {
      parentSessionID: input.parentSessionID,
    })
  }

  const clearLogicalTask = () => {
    log.info("[TRACE][CLEAR_LOGICAL_TASK] ProcessSupervisor.kill called", { toolCallID: input.toolCallID })
    ProcessSupervisor.kill(input.toolCallID)
  }

  // Always clear active child and logical task, even on early-exit errors.
  // Previously early exits skipped clearActiveChild, leaving the UI stuck
  // in "subagent running" state indefinitely.
  try {
    log.info("[TRACE][ENQUEUE_GET_PARENT] fetching parent session", { parentSessionID: input.parentSessionID })
    const parent = await Session.get(input.parentSessionID).catch(() => undefined)
    if (!parent) {
      log.error("[TRACE][ENQUEUE_EARLY_EXIT_1] parent session NOT FOUND", { parentSessionID: input.parentSessionID })
      throw new Error(`task_completion_parent_missing:${input.parentSessionID}`)
    }
    log.info("[TRACE][ENQUEUE_PARENT_FOUND] parent session found", {
      parentSessionID: input.parentSessionID,
      hasParentID: !!parent.parentID,
    })
    if (parent.parentID) {
      log.error("[TRACE][ENQUEUE_EARLY_EXIT_2] parent has parentID (nested)", {
        parentSessionID: input.parentSessionID,
        parentID: parent.parentID,
      })
      throw new Error(`task_completion_parent_nested_unsupported:${input.parentSessionID}`)
    }

    log.info("[TRACE][ENQUEUE_GET_MSG] fetching parent assistant message", {
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID,
    })
    const assistant = await MessageV2.get({
      sessionID: input.parentSessionID,
      messageID: input.parentMessageID,
    }).catch(() => undefined)
    if (!assistant || assistant.info.role !== "assistant") {
      log.error("[TRACE][ENQUEUE_EARLY_EXIT_3] parent assistant message NOT FOUND or wrong role", {
        parentSessionID: input.parentSessionID,
        parentMessageID: input.parentMessageID,
        found: !!assistant,
        role: assistant?.info?.role,
      })
      throw new Error(`task_completion_parent_message_missing:${input.parentMessageID}`)
    }
    log.info("[TRACE][ENQUEUE_MSG_FOUND] parent message found", {
      parentMessageID: input.parentMessageID,
      role: assistant.info.role,
      parts: assistant.parts.length,
    })

    const taskPart = assistant.parts.find(
      (part): part is MessageV2.ToolPart =>
        part.type === "tool" && part.callID === input.toolCallID && part.tool === "task",
    )
    log.info("[TRACE][ENQUEUE_FIND_TOOL_PART] searching for task tool part", {
      parentSessionID: input.parentSessionID,
      toolCallID: input.toolCallID,
      totalParts: assistant.parts.length,
      foundPart: !!taskPart,
      partTypes: assistant.parts
        .map((p: any) => ({ type: p.type, callID: (p as any).callID, tool: (p as any).tool }))
        .slice(0, 10),
    })
    if (!taskPart) {
      log.error("[TRACE][ENQUEUE_EARLY_EXIT_4] task tool part NOT FOUND", {
        parentSessionID: input.parentSessionID,
        toolCallID: input.toolCallID,
        partCallIDs: assistant.parts.filter((p: any) => p.type === "tool").map((p: any) => (p as any).callID),
      })
      throw new Error(`task_completion_tool_part_missing:${input.toolCallID}`)
    }
    log.info("[TRACE][ENQUEUE_TOOL_PART_FOUND] task tool part found", {
      toolCallID: input.toolCallID,
      partStatus: taskPart.state?.status,
    })

    // Fix: update tool part state from "running" to "completed"/"error" so sidebar monitor clears.
    //
    // R1 dispatch-first guard (issues/issue_20260611_dispatch-first-contract-break.md):
    // when the task tool returns its dispatch stub (task.ts Phase 9), the part is
    // ALREADY terminal (status="completed", output="Subagent … dispatched (jobId=…)").
    // Overwriting that output here with "completed successfully" rewrote the
    // persisted transcript (message-v2.ts replays part.state.output to the LLM),
    // so a subagent that died seconds after dispatch — e.g. a content-filter
    // kill, whose worker still reports ok=true — was replayed to the orchestrator
    // as a synchronous success. Terminal subagent results travel ONLY via the
    // task.completed → pending-notice channel; this subscriber may flip a
    // still-"running"/"pending" part so the sidebar clears, but must never
    // rewrite a terminal part's output.
    const alreadyTerminal = taskPart.state.status === "completed" || taskPart.state.status === "error"
    const partNow = Date.now()
    const startTime = taskPart.state.status === "running" ? taskPart.state.time.start : partNow
    const completedState: z.infer<typeof MessageV2.ToolState> = input.ok
      ? {
          status: "completed" as const,
          input: taskPart.state.input,
          // Deliberately non-success wording: worker ok=true only means the
          // worker loop returned (content-filter kills included). The actual
          // outcome arrives via the pending-notice on a subsequent turn.
          output: `Subagent ${input.childSessionID} finished. The outcome is delivered separately as a pending-notice; do not treat this line as a result.`,
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
    if (alreadyTerminal) {
      log.info("[DISPATCH_FIRST_GUARD] tool part already terminal — preserving existing output (R1 stub contract)", {
        parentSessionID: input.parentSessionID,
        toolCallID: input.toolCallID,
        childSessionID: input.childSessionID,
        existingStatus: taskPart.state.status,
      })
    } else {
      log.info("updating task tool part state", {
        parentSessionID: input.parentSessionID,
        toolCallID: input.toolCallID,
        childSessionID: input.childSessionID,
        previousStatus: taskPart.state?.status,
        newStatus: input.ok ? "completed" : "error",
      })
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
    }

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
          ? {
              phase: "complete",
              title: "title" in completedState ? completedState.title : "task",
              output: "output" in completedState ? completedState.output : "",
            }
          : { phase: "error", error: "error" in completedState ? completedState.error : "Unknown error" },
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

    // ── Demoted to UI-only subscriber ─────────────────────────────────
    // The primary completion channel is now the direct `done` promise that
    // the task tool caller awaits.  This Bus subscriber only handles:
    //   1. Tool part state update (running → completed/error) for sidebar
    //   2. Narration emission
    //   3. SharedContext merge (observability)
    // It no longer injects synthetic continuation messages or resumes the
    // parent's LLM loop — that is the task tool caller's responsibility.

    // T6 (compaction_simplification): SharedContext.mergeFrom retired.
    // The child session's workspace state is no longer merged into the
    // parent's persistent Space — parent reconstructs workspace in batch
    // from its own message stream at memory.read / compaction time.
    // Subagent results reach the parent via the task tool's done promise
    // and the parent's normal message-stream evolution.

    log.info("Bus subscriber UI update complete (demoted — no longer enqueues continuation)", {
      parentSessionID: input.parentSessionID,
      childSessionID: input.childSessionID,
      ok: input.ok,
    })

    // Close the outer try (line 49) — clearActiveChild + clearLogicalTask
    // always run, even on early-exit errors that previously left the UI stuck.
  } finally {
    await clearActiveChild().catch(() => undefined)
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
