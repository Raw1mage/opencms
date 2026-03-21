import { beforeAll, describe, expect, it } from "bun:test"
import { Instance } from "@/project/instance"
import { tmpdir } from "../../../test/fixture/fixture"
import { registerTaskWorkerContinuationSubscriber } from "./task-worker-continuation"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Identifier } from "@/id/id"
import { Todo } from "@/session/todo"
import { ProcessSupervisor } from "@/process/supervisor"
import { Bus } from "@/bus"
import { TaskWorkerEvent } from "@/tool/task"
import { getPendingContinuation } from "@/session/workflow-runner"

beforeAll(() => {
  registerTaskWorkerContinuationSubscriber()
})

describe("task worker continuation subscriber", () => {
  it("clears logical supervisor entry and marks linked todo waiting when continuation evidence fails", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        await Todo.update({
          sessionID: parent.id,
          todos: [{ id: "todo_a", content: "delegate API audit", status: "in_progress", priority: "high" }],
        })

        const parentMessageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: parentMessageID,
          role: "assistant",
          sessionID: parent.id,
          time: { created: Date.now() },
          modelID: "gpt-5.4",
          providerId: "openai",
          agent: "orchestrator",
          path: { cwd: tmp.path, root: tmp.path },
        } as MessageV2.Assistant)

        const toolCallID = "call_missing_tool_part"
        ProcessSupervisor.register({
          id: toolCallID,
          kind: "task-subagent",
          sessionID: parent.id,
          parentSessionID: parent.id,
        })

        await Bus.publish(TaskWorkerEvent.Failed, {
          workerID: "worker-1",
          sessionID: child.id,
          parentSessionID: parent.id,
          parentMessageID,
          toolCallID,
          linkedTodoID: "todo_a",
          error: "evidence missing",
        })

        await Bun.sleep(25)

        expect(ProcessSupervisor.snapshot().some((entry) => entry.id === toolCallID)).toBe(false)
        await expect(Todo.get(parent.id)).resolves.toEqual([
          {
            id: "todo_a",
            content: "delegate API audit",
            status: "in_progress",
            priority: "high",
            action: { kind: "delegate", canDelegate: true, waitingOn: "subagent" },
          },
        ])
        await expect(getPendingContinuation(parent.id)).resolves.toBeUndefined()
      },
    })
  })

  it("enqueues parent continuation, clears logical supervisor entry, and completes linked todo on success", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        await Todo.update({
          sessionID: parent.id,
          todos: [{ id: "todo_a", content: "delegate API audit", status: "in_progress", priority: "high" }],
        })

        const parentMessageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: parentMessageID,
          role: "assistant",
          sessionID: parent.id,
          time: { created: Date.now() },
          modelID: "gpt-5.4",
          providerId: "openai",
          agent: "orchestrator",
          path: { cwd: tmp.path, root: tmp.path },
        } as MessageV2.Assistant)

        const toolCallID = "call_success"
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: parentMessageID,
          sessionID: parent.id,
          type: "tool",
          callID: toolCallID,
          tool: "task",
          state: {
            status: "running",
            input: { description: "delegate API audit", prompt: "run audit", subagent_type: "coding" },
            time: { start: Date.now() },
          },
          metadata: { sessionId: child.id, status: "running", dispatched: true },
        })

        ProcessSupervisor.register({
          id: toolCallID,
          kind: "task-subagent",
          sessionID: parent.id,
          parentSessionID: parent.id,
        })

        await Bus.publish(TaskWorkerEvent.Done, {
          workerID: "worker-1",
          sessionID: child.id,
          parentSessionID: parent.id,
          parentMessageID,
          toolCallID,
          linkedTodoID: "todo_a",
        })

        await Bun.sleep(25)

        expect(ProcessSupervisor.snapshot().some((entry) => entry.id === toolCallID)).toBe(false)
        const pending = await getPendingContinuation(parent.id)
        expect(pending).toMatchObject({
          sessionID: parent.id,
          reason: "todo_pending",
        })
        await expect(Todo.get(parent.id)).resolves.toEqual([
          {
            id: "todo_a",
            content: "delegate API audit",
            status: "completed",
            priority: "high",
            action: { kind: "delegate", canDelegate: true },
          },
        ])
      },
    })
  })
})
