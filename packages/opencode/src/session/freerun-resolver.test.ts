import { describe, expect, test } from "bun:test"
import { FreerunResolver } from "./freerun-resolver"

/**
 * compaction_enrichment-ai-first task 3.4 — resolver boundary tests (DD-9/DD-10).
 * Pure decision core only; the session-scoped wrapper is integration-level.
 */
describe("FreerunResolver.decide", () => {
  test("contextLimit 128_000 (inclusive) routes to freerun", () => {
    expect(FreerunResolver.decide({ contextLimit: 128_000 })).toBe(true)
  })

  test("contextLimit 128_001 stays turn-based", () => {
    expect(FreerunResolver.decide({ contextLimit: 128_001 })).toBe(false)
  })

  test("contextLimit just below boundary routes to freerun", () => {
    expect(FreerunResolver.decide({ contextLimit: 32_000 })).toBe(true)
  })

  test("large window stays turn-based", () => {
    expect(FreerunResolver.decide({ contextLimit: 1_000_000 })).toBe(false)
  })

  test("undefined contextLimit stays turn-based", () => {
    expect(FreerunResolver.decide({})).toBe(false)
  })

  test("zero / negative contextLimit treated as unknown (no auto-route)", () => {
    expect(FreerunResolver.decide({ contextLimit: 0 })).toBe(false)
    expect(FreerunResolver.decide({ contextLimit: -1 })).toBe(false)
  })

  test("provider mode=freerun routes regardless of contextLimit", () => {
    expect(FreerunResolver.decide({ providerMode: "freerun", contextLimit: 1_000_000 })).toBe(true)
    expect(FreerunResolver.decide({ providerMode: "freerun" })).toBe(true)
  })

  test("provider mode=full / lite does not route on its own", () => {
    expect(FreerunResolver.decide({ providerMode: "full", contextLimit: 200_000 })).toBe(false)
    expect(FreerunResolver.decide({ providerMode: "lite", contextLimit: 200_000 })).toBe(false)
  })

  test("override=off exits freerun even when provider-tagged", () => {
    expect(FreerunResolver.decide({ providerMode: "freerun", override: "off" })).toBe(false)
  })

  test("override=off exits freerun even on small window", () => {
    expect(FreerunResolver.decide({ contextLimit: 64_000, override: "off" })).toBe(false)
  })

  test("override=on forces freerun on large window without provider tag", () => {
    expect(FreerunResolver.decide({ contextLimit: 1_000_000, override: "on" })).toBe(true)
    expect(FreerunResolver.decide({ override: "on" })).toBe(true)
  })

  test("override=off has priority over override-irrelevant signals combined", () => {
    expect(FreerunResolver.decide({ providerMode: "freerun", contextLimit: 8_000, override: "off" })).toBe(false)
  })

  test("SMALL_WINDOW_TOKENS constant is 128K", () => {
    expect(FreerunResolver.SMALL_WINDOW_TOKENS).toBe(128_000)
  })
})
