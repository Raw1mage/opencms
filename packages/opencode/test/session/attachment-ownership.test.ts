import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { LLM } from "../../src/session/llm"
import { ToolInvoker } from "../../src/session/tool-invoker"
import { TaskTool } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

describe("session.attachment-ownership", () => {
  afterEach(() => {
    mock.restore()
  })

  function streamWithToolAttachment(toolName: string) {
    return async function* () {
      yield { type: "start" }
      yield { type: "start-step" }
      yield { type: "tool-input-start", id: `call_${toolName}`, toolName }
      yield {
        type: "tool-call",
        toolCallId: `call_${toolName}`,
        toolName,
        input: { url: "https://example.com" },
      }
      yield {
        type: "tool-result",
        toolCallId: `call_${toolName}`,
        input: { url: "https://example.com" },
        output: {
          output: `${toolName} done`,
          title: toolName,
          metadata: { ok: true },
          attachments: [
            {
              type: "file",
              mime: "image/png",
              filename: `${toolName}.png`,
              url: "data:image/png;base64,Zm9v",
            },
          ],
        },
      }
      yield {
        type: "finish-step",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        providerMetadata: {},
      }
      yield { type: "finish" }
    }
  }

  function plainTextStream() {
    return async function* () {
      yield { type: "start" }
      yield { type: "start-step" }
      yield { type: "text-start" }
      yield { type: "text-delta", text: "done" }
      yield { type: "text-end" }
      yield {
        type: "finish-step",
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
        providerMetadata: {},
      }
      yield { type: "finish" }
    }
  }

  async function runOwnedAttachmentCase(toolName: "webfetch" | "batch") {
    spyOn(LLM, "stream").mockImplementation(async () => {
      return {
        fullStream: streamWithToolAttachment(toolName)(),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: { model: "openai/gpt-5.2" },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const assistant = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: `run ${toolName}` }],
        })

        if (assistant.info.role !== "assistant") throw new Error("expected assistant")
        const parts = await MessageV2.parts(assistant.info.id)
        const toolPart = parts.find((part) => part.type === "tool" && part.tool === toolName)
        if (!toolPart || toolPart.type !== "tool" || toolPart.state.status !== "completed") {
          throw new Error("expected completed tool part")
        }

        expect(toolPart.state.attachments?.length).toBe(1)
        const attachment = toolPart.state.attachments?.[0]
        expect(attachment?.id).toBeDefined()
        expect(attachment?.messageID).toBe(assistant.info.id)
        expect(attachment?.sessionID).toBe(session.id)
      },
    })
  }

  test("assigns ownership for webfetch tool-result attachments", async () => {
    await runOwnedAttachmentCase("webfetch")
  }, 15_000)

  test("assigns ownership for batch tool-result attachments", async () => {
    await runOwnedAttachmentCase("batch")
  }, 15_000)

  test("assigns ownership for subtask(TaskTool) attachments", async () => {
    spyOn(ToolInvoker, "execute").mockResolvedValue({
      title: "Subtask",
      output: "done",
      metadata: { ok: true },
      attachments: [
        {
          type: "file" as const,
          mime: "image/png",
          filename: "task.png",
          url: "data:image/png;base64,Zm9v",
        },
      ],
    })
    spyOn(LLM, "stream").mockImplementation(async () => {
      return {
        fullStream: plainTextStream()(),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: { model: "openai/gpt-5.2" },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [
            {
              type: "subtask",
              description: "ownership check",
              prompt: "run test subtask",
              agent: "coding",
            },
            { type: "text", text: "continue" },
          ],
        })

        const messages = await Session.messages({ sessionID: session.id })
        const taskAssistant = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "tool" && part.tool === TaskTool.id),
        )

        if (!taskAssistant || taskAssistant.info.role !== "assistant") throw new Error("expected task assistant")
        const taskPart = taskAssistant.parts.find((part) => part.type === "tool" && part.tool === TaskTool.id) as
          | MessageV2.ToolPart
          | undefined
        if (!taskPart || taskPart.state.status !== "completed") throw new Error("expected completed task part")

        expect(taskPart.state.attachments?.length).toBe(1)
        const attachment = taskPart.state.attachments?.[0]
        expect(attachment?.id).toBeDefined()
        expect(attachment?.messageID).toBe(taskAssistant.info.id)
        expect(attachment?.sessionID).toBe(session.id)
      },
    })
  })
})
