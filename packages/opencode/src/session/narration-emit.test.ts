import { describe, expect, it, mock } from "bun:test"

describe("emitSessionNarration", () => {
  it("preserves accountId on synthetic assistant messages", async () => {
    const updateMessage = mock(async (value: any) => value)
    const updatePart = mock(async (value: any) => value)

    mock.module(".", () => ({
      Session: {
        updateMessage,
        updatePart,
      },
    }))
    mock.module("@/project/instance", () => ({
      Instance: {
        directory: "/tmp/cwd",
        worktree: "/tmp/root",
      },
    }))

    const { emitSessionNarration } = await import("./narration")
    await emitSessionNarration({
      sessionID: "ses_test",
      parentID: "msg_parent",
      agent: "build",
      model: {
        providerId: "openai",
        modelID: "gpt-5.4",
        accountId: "openai-subscription-miatlab-api-gmail-com",
      },
      text: "Delegating to coding: investigate drift",
      kind: "task",
    })

    expect(updateMessage).toHaveBeenCalledTimes(1)
    expect(updateMessage.mock.calls[0]?.[0]).toMatchObject({
      role: "assistant",
      providerId: "openai",
      modelID: "gpt-5.4",
      accountId: "openai-subscription-miatlab-api-gmail-com",
    })
    expect(updatePart).toHaveBeenCalledTimes(1)
  })
})
