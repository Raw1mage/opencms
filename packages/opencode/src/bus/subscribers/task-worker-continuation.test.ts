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
import { SessionActiveChild, TaskWorkerEvent } from "@/tool/task"
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
          parentID: parent.id,
          sessionID: parent.id,
          time: { created: Date.now() },
          modelID: "gpt-5.4",
          providerId: "openai",
          mode: "manual",
          agent: "orchestrator",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
            action: { kind: "delegate", canDelegate: true },
          },
        ])
        await expect(getPendingContinuation(parent.id)).resolves.toBeUndefined()
      },
    })
  })

  it("clears supervisor/active-child on success WITHOUT enqueuing continuation or touching todos (demoted UI-only subscriber)", async () => {
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
          parentID: parent.id,
          sessionID: parent.id,
          time: { created: Date.now() },
          modelID: "gpt-5.4",
          providerId: "openai",
          mode: "manual",
          agent: "orchestrator",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
        await SessionActiveChild.set(parent.id, {
          sessionID: child.id,
          parentMessageID,
          toolCallID,
          workerID: "worker-1",
          title: "delegate API audit",
          agent: "coding",
          status: "running",
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
        expect(SessionActiveChild.get(parent.id)).toBeUndefined()
        // Demoted subscriber contract (see "Demoted to UI-only subscriber" note
        // in task-worker-continuation.ts): it must NOT enqueue a continuation
        // and must NOT reconcile todos — both are the task tool caller's job
        // (task.ts reconcileProgress + done-promise channel). The old
        // assertions encoded the pre-demotion architecture and were failing
        // ever since (pre-existing fail noted in issue_20260611 Resolution).
        await expect(getPendingContinuation(parent.id)).resolves.toBeUndefined()
        await expect(Todo.get(parent.id)).resolves.toEqual([
          {
            id: "todo_a",
            content: "delegate API audit",
            status: "in_progress",
            priority: "high",
            action: { kind: "delegate", canDelegate: true },
          },
        ])
      },
    })
  })

  it("never rewrites a terminal dispatched-stub part's output (R1 dispatch-first contract, issue_20260611)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })

        const parentMessageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: parentMessageID,
          role: "assistant",
          parentID: parent.id,
          sessionID: parent.id,
          time: { created: Date.now() },
          modelID: "gpt-5.4",
          providerId: "openai",
          mode: "manual",
          agent: "orchestrator",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as MessageV2.Assistant)

        // Simulate the Phase 9 stub return: the task tool already wrote a
        // TERMINAL part whose output is the dispatch stub. A content-filter
        // kill makes the worker report Done (ok=true) seconds later — the
        // subscriber must NOT rewrite this output to "completed successfully".
        const toolCallID = "call_dispatched_stub"
        const stubOutput = `Subagent ${child.id} dispatched (jobId=job_x). Running in background.`
        const partID = Identifier.ascending("part")
        await Session.updatePart({
          id: partID,
          messageID: parentMessageID,
          sessionID: parent.id,
          type: "tool",
          callID: toolCallID,
          tool: "task",
          state: {
            status: "completed",
            input: { description: "doomed dispatch", prompt: "x", subagent_type: "coding" },
            output: stubOutput,
            title: "doomed dispatch",
            metadata: { dispatched: true, sessionId: child.id, jobId: "job_x", status: "dispatched" },
            time: { start: Date.now(), end: Date.now() },
          },
        })

        ProcessSupervisor.register({
          id: toolCallID,
          kind: "task-subagent",
          sessionID: parent.id,
          parentSessionID: parent.id,
        })
        await SessionActiveChild.set(parent.id, {
          sessionID: child.id,
          parentMessageID,
          toolCallID,
          workerID: "worker-1",
          title: "doomed dispatch",
          agent: "coding",
          status: "running",
        })

        await Bus.publish(TaskWorkerEvent.Done, {
          workerID: "worker-1",
          sessionID: child.id,
          parentSessionID: parent.id,
          parentMessageID,
          toolCallID,
        })

        await Bun.sleep(25)

        // Sidebar/process cleanup still happens…
        expect(ProcessSupervisor.snapshot().some((entry) => entry.id === toolCallID)).toBe(false)
        expect(SessionActiveChild.get(parent.id)).toBeUndefined()

        // …but the persisted tool part output is byte-identical to the stub.
        const msg = await MessageV2.get({ sessionID: parent.id, messageID: parentMessageID })
        const part = msg.parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === toolCallID)
        expect(part).toBeDefined()
        expect(part!.state.status).toBe("completed")
        expect((part!.state as any).output).toBe(stubOutput)
        expect((part!.state as any).output).not.toContain("completed successfully")
      },
    })
  })
})
