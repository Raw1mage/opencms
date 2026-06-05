import { afterEach, describe, expect, mock, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"
import type { SessionStorage } from "../../src/session/storage"

mock.module("ai", () => ({
  generateText: mock(async () => ({ text: "reader digest" })),
}))

describe("tool.attachment account routing", () => {
  afterEach(async () => {
    const attachment = await import("../../src/tool/attachment")
    attachment.setAttachmentQueryReaderForTesting()
    attachment.setReaderRunnerForTesting()
    mock.restore()
  })

  test("passes session-pinned accountId into Provider.getLanguage for reader dispatch", async () => {
    const blob: SessionStorage.AttachmentBlob = {
      sessionID: "session_placeholder",
      refID: "att_image",
      mime: "image/png",
      filename: "image.png",
      byteSize: 3,
      estTokens: 1,
      createdAt: Date.now(),
      content: new Uint8Array([1, 2, 3]),
    }
    let seenAccountId: string | undefined

    mock.module("@/session/system", () => ({
      SystemPrompt: { agentPrompt: mock(async () => "reader system prompt") },
    }))
    mock.module("@/provider/provider", () => ({
      Provider: {
        getModel: mock(async () => ({
          providerId: "openai",
          id: "gpt-5.4",
          name: "GPT 5.4",
          release_date: "2026-01-01",
          attachment: true,
          reasoning: false,
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          limit: { context: 128_000, output: 16_000 },
          options: {},
          capabilities: { input: { text: true, image: true, pdf: false } },
          api: { npm: "@ai-sdk/openai" },
        })),
        getLanguage: mock(async (_model: unknown, accountId?: string) => {
          seenAccountId = accountId
          return {}
        }),
      },
    }))

    const attachment = await import("../../src/tool/attachment")
    const tool = await attachment.AttachmentTool.init()
    attachment.setAttachmentQueryReaderForTesting({
      getAttachmentBlob: async () => blob,
    })

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Session.pinExecutionIdentity({
          sessionID: session.id,
          model: {
            providerId: "openai",
            modelID: "gpt-5.4",
            accountId: "openai-subscription-reader-pin",
          },
        })

        await tool.execute(
          { ref_id: "att_image", mode: "read", question: "Describe the image", agent: "vision" },
          {
            sessionID: session.id,
            messageID: "msg_test",
            callID: "call_test",
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        )
      },
    })

    expect(seenAccountId).toBe("openai-subscription-reader-pin")
  })
})
