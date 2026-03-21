import { describe, expect, it } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { TaskTool } from "../../src/tool/task"

describe("task tool", () => {
  it("fails fast for nested task delegation before dispatch", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const child = await Session.create({ parentID: root.id })
        const assistantMessageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: assistantMessageID,
          role: "assistant",
          sessionID: child.id,
          time: { created: Date.now() },
          modelID: "gpt-5.4",
          providerId: "openai",
          agent: "coding",
          path: { cwd: tmp.path, root: tmp.path },
        } as MessageV2.Assistant)

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
})
