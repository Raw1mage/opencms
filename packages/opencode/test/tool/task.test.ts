import { describe, expect, it } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { SessionActiveChild, TaskTool } from "../../src/tool/task"

function assistantMessageFixture(input: { sessionID: string; cwd: string }): MessageV2.Assistant {
  return {
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID: input.sessionID,
    time: { created: Date.now() },
    parentID: "msg_parent",
    modelID: "gpt-5.4",
    providerId: "openai",
    mode: "prompt",
    agent: "coding",
    path: { cwd: input.cwd, root: input.cwd },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }
}

describe("task tool", () => {
  it("fails fast for nested task delegation before dispatch", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const child = await Session.create({ parentID: root.id })
        const assistantMessage = assistantMessageFixture({ sessionID: child.id, cwd: tmp.path })
        const assistantMessageID = assistantMessage.id
        await Session.updateMessage(assistantMessage)

        const tool = await TaskTool.init()
        await expect(
          tool.execute(
            {
              description: "delegate work",
              prompt: "do the thing",
              subagent_type: "coding",
            },
            {
              sessionID: child.id,
              messageID: assistantMessageID,
              agent: "coding",
              abort: new AbortController().signal,
              callID: "nested_call",
              messages: [],
              extra: { bypassAgentCheck: true },
              metadata: () => undefined,
              ask: async () => undefined,
            },
          ),
        ).rejects.toThrow(`nested_task_delegation_unsupported:${child.id}`)
      },
    })
  })

  it("clears stale running active child before dispatch gating", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const assistantMessage = assistantMessageFixture({ sessionID: root.id, cwd: tmp.path })
        const assistantMessageID = assistantMessage.id
        await Session.updateMessage(assistantMessage)

        await SessionActiveChild.set(root.id, {
          sessionID: Identifier.descending("session"),
          parentMessageID: assistantMessageID,
          toolCallID: "stale_call",
          workerID: "missing-worker",
          title: "stale child",
          agent: "coding",
          status: "running",
        })

        const tool = await TaskTool.init()
        await expect(
          tool.execute(
            {
              description: "delegate work",
              prompt: "do the thing",
              subagent_type: "missing-agent",
            },
            {
              sessionID: root.id,
              messageID: assistantMessageID,
              agent: "coding",
              abort: new AbortController().signal,
              callID: "stale_call_parent",
              messages: [],
              extra: { bypassAgentCheck: true },
              metadata: () => undefined,
              ask: async () => undefined,
            },
          ),
        ).rejects.toThrow("Unknown agent type: missing-agent is not a valid agent type")

        expect(SessionActiveChild.get(root.id)).toBeUndefined()
      },
    })
  })

  it("still blocks dispatch when active child is in handoff", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const assistantMessage = assistantMessageFixture({ sessionID: root.id, cwd: tmp.path })
        const assistantMessageID = assistantMessage.id
        await Session.updateMessage(assistantMessage)

        const handoffSessionID = Identifier.descending("session")
        await SessionActiveChild.set(root.id, {
          sessionID: handoffSessionID,
          parentMessageID: assistantMessageID,
          toolCallID: "handoff_call",
          workerID: "handoff",
          title: "handoff child",
          agent: "coding",
          status: "handoff",
        })

        const tool = await TaskTool.init()
        await expect(
          tool.execute(
            {
              description: "delegate work",
              prompt: "do the thing",
              subagent_type: "missing-agent",
            },
            {
              sessionID: root.id,
              messageID: assistantMessageID,
              agent: "coding",
              abort: new AbortController().signal,
              callID: "handoff_call_parent",
              messages: [],
              extra: { bypassAgentCheck: true },
              metadata: () => undefined,
              ask: async () => undefined,
            },
          ),
        ).rejects.toThrow(`active_child_dispatch_blocked:${root.id}:${handoffSessionID}:handoff`)
      },
    })
  })
})
