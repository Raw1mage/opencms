import { describe, test, expect } from "bun:test"
import { resolveAutoModel } from "@/plugin/copilot-cli/models"

// These tests exercise the size-heuristic tiering of the `auto` router.
// No Copilot profile is loaded in the test process, so getCachedPremiumQuota()
// resolves to null and the quota-aware downshift is a no-op — leaving the pure
// prompt-size heuristic under test.

function promptOf(tokens: number): string {
  // ToolBudget.estimateTokens counts pure ASCII as ceil(len/4), so length ≈ 4×tokens.
  return "x".repeat(tokens * 4)
}

describe("resolveAutoModel size heuristic", () => {
  test("small request → lightweight (gpt-5.4-mini)", async () => {
    expect(await resolveAutoModel({ promptText: promptOf(8_000) })).toBe("gpt-5.4-mini")
  })

  test("medium request → versatile (gpt-4.1)", async () => {
    expect(await resolveAutoModel({ promptText: promptOf(80_000) })).toBe("gpt-4.1")
  })

  test("large request → powerful (gemini-3.1-pro-preview)", async () => {
    expect(await resolveAutoModel({ promptText: promptOf(220_000) })).toBe("gemini-3.1-pro-preview")
  })

  test("just below versatile threshold stays lightweight", async () => {
    expect(await resolveAutoModel({ promptText: promptOf(60_000) })).toBe("gpt-5.4-mini")
  })

  test("explicit high reasoning effort nudges a small request off lightweight", async () => {
    expect(await resolveAutoModel({ promptText: promptOf(8_000), reasoningEffort: "high" })).toBe("gpt-4.1")
  })

  test("high reasoning effort does not downgrade an already-powerful tier", async () => {
    expect(await resolveAutoModel({ promptText: promptOf(220_000), reasoningEffort: "xhigh" })).toBe(
      "gemini-3.1-pro-preview",
    )
  })

  test("empty prompt → lightweight", async () => {
    expect(await resolveAutoModel({ promptText: "" })).toBe("gpt-5.4-mini")
  })
})
