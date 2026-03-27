import { describe, expect, it } from "bun:test"
import { MessageV2 } from "./message-v2"

const SEPARATOR =
  "--- You are now operating as a delegated subagent. Above is the parent session's full context. Your assigned task follows below. ---"

describe("context sharing v2 prompt assembly", () => {
  it("prepends full parent history, then separator, then child prompt messages", () => {
    const model = {
      id: "gpt-5.4",
      providerId: "openai",
    } as any

    const parentMessages: MessageV2.WithParts[] = [
      {
        info: { id: "parent-user", role: "user" } as any,
        parts: [
          {
            id: "part-parent-user",
            sessionID: "parent-session",
            messageID: "parent-user",
            type: "text",
            text: "parent user context",
          },
        ],
      },
      {
        info: {
          id: "parent-assistant",
          role: "assistant",
          providerId: "openai",
          modelID: "gpt-5.4",
        } as any,
        parts: [
          {
            id: "part-parent-assistant",
            sessionID: "parent-session",
            messageID: "parent-assistant",
            type: "text",
            text: "parent assistant context",
          },
        ],
      },
    ]

    const childMessages: MessageV2.WithParts[] = [
      {
        info: { id: "child-user", role: "user" } as any,
        parts: [
          {
            id: "part-child-user",
            sessionID: "child-session",
            messageID: "child-user",
            type: "text",
            text: "child task prompt",
          },
        ],
      },
    ]

    const assembled = [
      ...MessageV2.toModelMessages(parentMessages, model),
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: SEPARATOR }],
      },
      ...MessageV2.toModelMessages(childMessages, model),
    ]

    expect(assembled).toHaveLength(4)
    expect(assembled[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "parent user context" }],
    })
    expect(assembled[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "parent assistant context" }],
    })
    expect(assembled[2]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: SEPARATOR }],
    })
    expect(assembled[3]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "child task prompt" }],
    })
  })
})
