import { describe, expect, it } from "bun:test"

import { MessageV2 } from "./message-v2"

describe("MessageV2.AttachmentRefPart", () => {
  it("accepts session-scoped attachment_ref parts", () => {
    const parsed = MessageV2.Part.parse({
      id: "prt_attachmentref000000000000",
      sessionID: "ses_attachmentref0000000000",
      messageID: "msg_attachmentref0000000000",
      type: "attachment_ref",
      ref_id: "att_ref_001",
      mime: "text/plain",
      filename: "large.txt",
      est_tokens: 6000,
      byte_size: 24000,
      preview: "large file preview",
      dimensions: { w: 1200, h: 800 },
    })

    expect(parsed.type).toBe("attachment_ref")
    expect(parsed.ref_id).toBe("att_ref_001")
  })

  it("rejects attachment_ref parts missing required metadata", () => {
    expect(() =>
      MessageV2.Part.parse({
        id: "prt_attachmentref000000000001",
        sessionID: "ses_attachmentref0000000000",
        messageID: "msg_attachmentref0000000000",
        type: "attachment_ref",
        ref_id: "att_ref_002",
        mime: "text/plain",
      }),
    ).toThrow()
  })

  it("renders attachment_ref as lightweight model text", () => {
    const messages = MessageV2.toModelMessages(
      [
        {
          info: {
            id: "msg_attachmentref0000000000",
            sessionID: "ses_attachmentref0000000000",
            role: "user",
            time: { created: 1700000000000 },
            agent: "build",
            model: { providerId: "anthropic", modelID: "claude-test" },
          },
          parts: [
            {
              id: "prt_attachmentref0000000000",
              sessionID: "ses_attachmentref0000000000",
              messageID: "msg_attachmentref0000000000",
              type: "attachment_ref",
              ref_id: "prt_ref_001",
              mime: "text/plain",
              filename: "large.txt",
              est_tokens: 6000,
              byte_size: 24000,
              preview: "short preview",
            },
          ],
        },
      ],
      { id: "claude-test", providerId: "anthropic" } as any,
    )

    const rendered = JSON.stringify(messages)
    expect(rendered).toContain("attachment_ref")
    expect(rendered).toContain("prt_ref_001")
    expect(rendered).toContain("short preview")
    expect(rendered).not.toContain("large raw body")
  })

})
