import { describe, it, expect, afterEach } from "bun:test"
import {
  recordSystemBlockHash,
  diagnoseCacheMiss,
  readSystemBlockHashes,
  _resetCacheMissDiagnostic,
} from "./cache-miss-diagnostic"

afterEach(() => {
  _resetCacheMissDiagnostic()
})

describe("cache miss diagnostic (DD-10)", () => {
  it("recordSystemBlockHash returns the same hash for the same input", () => {
    const a = recordSystemBlockHash("s1", "system text X")
    _resetCacheMissDiagnostic()
    const b = recordSystemBlockHash("s1", "system text X")
    expect(a).toBe(b)
  })

  it("rolling window keeps last 3 entries", () => {
    recordSystemBlockHash("s1", "v1")
    recordSystemBlockHash("s1", "v2")
    recordSystemBlockHash("s1", "v3")
    recordSystemBlockHash("s1", "v4")
    expect(readSystemBlockHashes("s1")).toHaveLength(3)
  })

  it("kind=neither when fewer than 2 hashes recorded", () => {
    recordSystemBlockHash("s1", "v1")
    const d = diagnoseCacheMiss({ sessionID: "s1", conversationTailTokens: 60_000 })
    expect(d.kind).toBe("neither")
    expect(d.shouldCompact).toBe(false)
  })

  it("kind=system-prefix-churn when 3 hashes vary", () => {
    recordSystemBlockHash("s1", "v1")
    recordSystemBlockHash("s1", "v2")
    recordSystemBlockHash("s1", "v3")
    const d = diagnoseCacheMiss({ sessionID: "s1", conversationTailTokens: 60_000 })
    expect(d.kind).toBe("system-prefix-churn")
    expect(d.shouldCompact).toBe(false)
  })

  it("kind=conversation-growth when 3 hashes equal AND tail > 40K", () => {
    recordSystemBlockHash("s1", "stable")
    recordSystemBlockHash("s1", "stable")
    recordSystemBlockHash("s1", "stable")
    const d = diagnoseCacheMiss({ sessionID: "s1", conversationTailTokens: 60_000 })
    expect(d.kind).toBe("conversation-growth")
    expect(d.shouldCompact).toBe(true)
  })

  it("kind=neither when 3 hashes equal but tail below threshold", () => {
    recordSystemBlockHash("s1", "stable")
    recordSystemBlockHash("s1", "stable")
    recordSystemBlockHash("s1", "stable")
    const d = diagnoseCacheMiss({ sessionID: "s1", conversationTailTokens: 25_000 })
    expect(d.kind).toBe("neither")
    expect(d.shouldCompact).toBe(false)
  })

  it("partial churn (2 same, 1 different) classified as churn", () => {
    recordSystemBlockHash("s1", "v1")
    recordSystemBlockHash("s1", "v1")
    recordSystemBlockHash("s1", "v2")
    const d = diagnoseCacheMiss({ sessionID: "s1", conversationTailTokens: 60_000 })
    expect(d.kind).toBe("system-prefix-churn")
  })

  it("custom minTailTokens threshold respected", () => {
    recordSystemBlockHash("s1", "stable")
    recordSystemBlockHash("s1", "stable")
    const d = diagnoseCacheMiss({
      sessionID: "s1",
      conversationTailTokens: 10_000,
      minTailTokens: 5_000,
    })
    expect(d.kind).toBe("conversation-growth")
    expect(d.shouldCompact).toBe(true)
  })

  it("isolated by sessionID", () => {
    recordSystemBlockHash("s1", "X")
    recordSystemBlockHash("s2", "Y")
    expect(readSystemBlockHashes("s1")).toEqual(readSystemBlockHashes("s1"))
    expect(readSystemBlockHashes("s1")[0]).not.toBe(readSystemBlockHashes("s2")[0])
  })
})
