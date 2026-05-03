import { describe, it, expect } from "bun:test"
import { MessageV2 } from "./message-v2"

describe("MessageV2.User.kind = 'context-preface' (DD-5)", () => {
  const baseUser = {
    id: "msg_user_01",
    sessionID: "ses_01",
    role: "user" as const,
    time: { created: 1_700_000_000_000 },
    agent: "build",
    model: { providerId: "anthropic", modelID: "claude-sonnet-4-6" },
  }

  it("accepts a user message without kind (backwards compat with pre-Phase-B sessions)", () => {
    const parsed = MessageV2.User.parse(baseUser)
    expect(parsed.kind).toBeUndefined()
    expect(parsed.role).toBe("user")
  })

  it("accepts kind='context-preface'", () => {
    const parsed = MessageV2.User.parse({ ...baseUser, kind: "context-preface" })
    expect(parsed.kind).toBe("context-preface")
  })

  it("rejects any other kind value", () => {
    expect(() => MessageV2.User.parse({ ...baseUser, kind: "user-typed" })).toThrow()
    expect(() => MessageV2.User.parse({ ...baseUser, kind: "" })).toThrow()
  })

  it("serialization roundtrip preserves kind", () => {
    const original = { ...baseUser, kind: "context-preface" as const }
    const serialized = JSON.stringify(MessageV2.User.parse(original))
    const reparsed = MessageV2.User.parse(JSON.parse(serialized))
    expect(reparsed.kind).toBe("context-preface")
  })

  it("serialization roundtrip omits kind when absent", () => {
    const serialized = JSON.stringify(MessageV2.User.parse(baseUser))
    expect(JSON.parse(serialized)).not.toHaveProperty("kind")
    const reparsed = MessageV2.User.parse(JSON.parse(serialized))
    expect(reparsed.kind).toBeUndefined()
  })
})
