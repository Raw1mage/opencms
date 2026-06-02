/**
 * chain-log.test.ts — cache-chain-hotfix W1 evidence sink.
 * Covers classifyReset (the resetClass KPI classifier) + the JSONL append
 * contract (path injection, never-throws, no-op when unwired).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  appendChainEvent,
  classifyReset,
  nextChainSeq,
  setChainLogPath,
  _resetChainLogForTest,
  _getChainLogPathForTest,
} from "./chain-log"

afterEach(() => _resetChainLogForTest())

describe("classifyReset (resetClass KPI)", () => {
  test("chainResetReason present → length_not_grown (the fix KPI), regardless of other fields", () => {
    expect(classifyReset({ hasPrevResp: false, chainResetReason: "length_not_grown(prev=150,now=150)" })).toBe(
      "length_not_grown",
    )
    expect(
      classifyReset({ hasPrevResp: true, chainResetReason: "length_not_grown(prev=1,now=1)", cachedTokens: 0 }),
    ).toBe("length_not_grown")
  })

  test("no previous_response_id sent → chainless (doInvalidate path)", () => {
    expect(classifyReset({ hasPrevResp: false, chainResetReason: null })).toBe("chainless")
    expect(classifyReset({ hasPrevResp: false, chainResetReason: undefined, cachedTokens: 123 })).toBe("chainless")
  })

  test("prev_resp sent but server cached 0 → server_evict", () => {
    expect(classifyReset({ hasPrevResp: true, chainResetReason: null, cachedTokens: 0 })).toBe("server_evict")
  })

  test("prev_resp sent and server cached > 0 → none (healthy delta)", () => {
    expect(classifyReset({ hasPrevResp: true, chainResetReason: null, cachedTokens: 24064 })).toBe("none")
  })

  test("prev_resp sent, cachedTokens unknown (REQ-time) → none provisionally", () => {
    expect(classifyReset({ hasPrevResp: true, chainResetReason: null })).toBe("none")
  })
})

describe("appendChainEvent (JSONL sink)", () => {
  test("writes one JSONL line per call to the injected path", () => {
    const dir = mkdtempSync(join(tmpdir(), "chainlog-"))
    const file = join(dir, "nested", "ws-chain.jsonl")
    try {
      setChainLogPath(file)
      appendChainEvent({ kind: "req", seq: nextChainSeq(), resetClass: "length_not_grown" })
      appendChainEvent({ kind: "usage", seq: nextChainSeq(), resetClass: "none" })
      const lines = readFileSync(file, "utf-8").trim().split("\n")
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]).resetClass).toBe("length_not_grown")
      expect(JSON.parse(lines[1]).kind).toBe("usage")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("no path injected → silent no-op, never throws", () => {
    expect(_getChainLogPathForTest()).toBeNull()
    expect(() => appendChainEvent({ kind: "req" })).not.toThrow()
  })

  test("write failure never throws (path is a directory)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chainlog-"))
    try {
      setChainLogPath(dir) // appending to a directory path errors → must be swallowed
      expect(() => appendChainEvent({ kind: "req" })).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("nextChainSeq is monotonic from 0 after reset", () => {
    _resetChainLogForTest()
    expect(nextChainSeq()).toBe(0)
    expect(nextChainSeq()).toBe(1)
    expect(existsSync("/nonexistent-sentinel")).toBe(false)
  })
})
