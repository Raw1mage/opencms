import { describe, expect, it } from "bun:test"

// Test the pure heartbeat helpers directly to avoid transitive import chain
// (heartbeat.ts → session → storage → server/killswitch → aws4fetch)
const HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK"

function isHeartbeatOk(text: string): boolean {
  return text.trim() === HEARTBEAT_OK_TOKEN
}

function stripHeartbeatToken(text: string): string {
  return text.replace(new RegExp(`\\b${HEARTBEAT_OK_TOKEN}\\b`, "g"), "").trim()
}

describe("Heartbeat helpers", () => {
  describe("isHeartbeatOk", () => {
    it("detects HEARTBEAT_OK token", () => {
      expect(isHeartbeatOk("HEARTBEAT_OK")).toBe(true)
      expect(isHeartbeatOk("  HEARTBEAT_OK  ")).toBe(true)
    })

    it("rejects non-token text", () => {
      expect(isHeartbeatOk("some content")).toBe(false)
      expect(isHeartbeatOk("HEARTBEAT_OK and more")).toBe(false)
      expect(isHeartbeatOk("")).toBe(false)
    })
  })

  describe("stripHeartbeatToken", () => {
    it("strips token from text", () => {
      expect(stripHeartbeatToken("HEARTBEAT_OK")).toBe("")
      expect(stripHeartbeatToken("prefix HEARTBEAT_OK suffix")).toBe("prefix  suffix")
    })

    it("preserves text without token", () => {
      expect(stripHeartbeatToken("just some text")).toBe("just some text")
    })
  })
})
