import { describe, expect, it } from "bun:test"
import { Truncate } from "./truncation"
import { ToolBudget } from "./budget"

// session_tool-output-redirection R1/R3: the externalization gate is token-based
// and the inline preview is a small token bound (not the old 256KB byte preview
// that left a redirected result still huge in the prompt every turn).
describe("Truncate.output — token gate + small preview", () => {
  it("small result stays inline (behaviour-preserving)", async () => {
    const r = await Truncate.output("hello\nworld\nthis is small")
    expect(r.truncated).toBe(false)
    if (!r.truncated) expect(r.content).toContain("hello")
  })

  it("large result is externalized with a SMALL token-bounded preview + handle", async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `line ${i} some content here`).join("\n")
    const r = await Truncate.output(big, {}, undefined, undefined)
    expect(r.truncated).toBe(true)
    // The whole inline content (preview + hint) must be small — the bug was a
    // preview capped at 256KB (~64K tokens). Now it is ~PREVIEW_TOKENS.
    expect(ToolBudget.estimateTokens(r.content)).toBeLessThan(1500)
    expect(r.content).toContain("Full output saved to")
    if (r.truncated) expect(r.outputPath).toBeTruthy()
  })

  it("honours an explicit previewTokens override", async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n")
    const r = await Truncate.output(big, { previewTokens: 50 }, undefined, undefined)
    expect(r.truncated).toBe(true)
    expect(ToolBudget.estimateTokens(r.content)).toBeLessThan(400) // ~50 preview + hint
  })

  it("gates on tokens: a CJK-heavy result over the token cap externalizes even under the old byte cap", async () => {
    // ~80K CJK chars ≈ ~80K tokens (CJK-aware) but only ~240KB bytes (< 256KB old cap).
    const cjk = "文件內容".repeat(20000)
    expect(ToolBudget.estimateTokens(cjk)).toBeGreaterThan(60000)
    const r = await Truncate.output(cjk, {}, undefined, undefined)
    expect(r.truncated).toBe(true)
  })
})
