import { describe, expect, test } from "bun:test"
import { detectAutorunIntent, extractUserText } from "../../src/session/autorun/detector"
import { Tweaks } from "../../src/config/tweaks"

/**
 * Phase 4.5 of specs/autonomous-opt-in/ — detector unit tests.
 * Covers the six test-vector categories from tasks.md 4.5:
 *   positive / negative / case / multilingual / embedded / idempotency.
 */

const CFG: Tweaks.AutorunConfig = {
  triggerPhrases: ["接著跑", "autorun", "keep going"],
  disarmPhrases: ["停", "stop"],
}

describe("detectAutorunIntent", () => {
  test("returns null for empty or whitespace-only text", () => {
    expect(detectAutorunIntent("", CFG)).toBeNull()
    // Whitespace-only text has no phrase match → null (detector does not
    // early-return on whitespace, but no configured phrase is whitespace).
    expect(detectAutorunIntent("   \n\n  ", CFG)).toBeNull()
  })

  test("positive match on exact trigger phrase", () => {
    expect(detectAutorunIntent("autorun", CFG)).toEqual({ kind: "arm", phrase: "autorun" })
    expect(detectAutorunIntent("接著跑", CFG)).toEqual({ kind: "arm", phrase: "接著跑" })
  })

  test("positive match on disarm phrase", () => {
    expect(detectAutorunIntent("stop", CFG)).toEqual({ kind: "disarm", phrase: "stop" })
    expect(detectAutorunIntent("停", CFG)).toEqual({ kind: "disarm", phrase: "停" })
  })

  test("negative — text without any configured phrase returns null", () => {
    expect(detectAutorunIntent("please continue the work", CFG)).toBeNull()
    expect(detectAutorunIntent("hello world", CFG)).toBeNull()
  })

  test("case-insensitive — EN phrases match regardless of case", () => {
    expect(detectAutorunIntent("AUTORUN", CFG)).toEqual({ kind: "arm", phrase: "autorun" })
    expect(detectAutorunIntent("AutoRun", CFG)).toEqual({ kind: "arm", phrase: "autorun" })
    expect(detectAutorunIntent("STOP!", CFG)).toEqual({ kind: "disarm", phrase: "stop" })
  })

  test("multilingual — CJK phrases match across script without conversion", () => {
    expect(detectAutorunIntent("接著跑", CFG)).toEqual({ kind: "arm", phrase: "接著跑" })
    expect(detectAutorunIntent("好，那就接著跑吧", CFG)).toEqual({ kind: "arm", phrase: "接著跑" })
  })

  test("embedded-in-sentence — phrase anywhere in text triggers", () => {
    expect(detectAutorunIntent("ok autorun please", CFG)).toEqual({ kind: "arm", phrase: "autorun" })
    expect(detectAutorunIntent("please keep going with step 3", CFG)).toEqual({
      kind: "arm",
      phrase: "keep going",
    })
  })

  test("trigger wins over disarm when both present in same message", () => {
    const result = detectAutorunIntent("autorun and then stop", CFG)
    expect(result).toEqual({ kind: "arm", phrase: "autorun" })
  })

  test("first matching trigger wins (list order matters for reason label)", () => {
    const cfg: Tweaks.AutorunConfig = {
      triggerPhrases: ["autorun", "keep going"],
      disarmPhrases: [],
    }
    const result = detectAutorunIntent("keep going and autorun", cfg)
    // "autorun" appears earlier in the trigger list → it wins even if the
    // literal text order puts "keep going" first.
    expect(result).toEqual({ kind: "arm", phrase: "autorun" })
  })

  test("empty phrase config — no detection possible, returns null", () => {
    const cfg: Tweaks.AutorunConfig = { triggerPhrases: [], disarmPhrases: [] }
    expect(detectAutorunIntent("autorun stop", cfg)).toBeNull()
  })

  test("ignores empty phrases in config (defensive against `a||b` parse)", () => {
    const cfg: Tweaks.AutorunConfig = {
      triggerPhrases: ["", "autorun"],
      disarmPhrases: [""],
    }
    expect(detectAutorunIntent("autorun", cfg)).toEqual({ kind: "arm", phrase: "autorun" })
    // Empty disarm phrase must not match any text
    expect(detectAutorunIntent("anything", cfg)).toBeNull()
  })

  test("idempotency — same input always produces same output", () => {
    const text = "please autorun"
    const r1 = detectAutorunIntent(text, CFG)
    const r2 = detectAutorunIntent(text, CFG)
    expect(r1).toEqual(r2)
  })
})

describe("extractUserText", () => {
  test("joins non-synthetic text parts with newlines", () => {
    const parts = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]
    expect(extractUserText(parts)).toBe("hello\nworld")
  })

  test("skips synthetic parts", () => {
    const parts = [
      { type: "text", text: "user wrote this" },
      { type: "text", text: "autorun", synthetic: true },
    ]
    // Synthetic arm phrases (e.g. from runner continuation) must not retrigger
    expect(extractUserText(parts)).toBe("user wrote this")
  })

  test("skips non-text parts (file, tool, agent)", () => {
    const parts = [
      { type: "file", text: "should be ignored" },
      { type: "text", text: "real user text" },
      { type: "tool", text: "tool result" },
    ]
    expect(extractUserText(parts)).toBe("real user text")
  })

  test("skips empty text parts", () => {
    const parts = [
      { type: "text", text: "" },
      { type: "text", text: "actual" },
      { type: "text" },
    ]
    expect(extractUserText(parts)).toBe("actual")
  })

  test("returns empty string on empty input", () => {
    expect(extractUserText([])).toBe("")
  })

  test("trims the final joined string", () => {
    const parts = [
      { type: "text", text: "  leading and trailing  " },
    ]
    expect(extractUserText(parts)).toBe("leading and trailing")
  })
})
