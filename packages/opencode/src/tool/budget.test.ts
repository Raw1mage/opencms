/**
 * ToolBudget.estimateTokens — the codebase's single shared token estimator.
 *
 * plan compaction_anchor-unbounded-growth: upgraded to be CJK-aware. The
 * load-bearing invariant is that pure ASCII/Latin text returns EXACTLY the old
 * Math.ceil(length/4) (so tool-output slicing and every other caller is
 * byte-identical for non-CJK), while CJK-bearing text is counted ~1 token/char
 * (close to the model's real usage) instead of ~0.25.
 */
import { describe, expect, it } from "bun:test"
import { ToolBudget } from "./budget"

const legacyDiv4 = (s: string) => Math.ceil(s.length / 4)

describe("ToolBudget.estimateTokens — CJK-aware, ASCII byte-identical", () => {
  it("pure ASCII / Latin / code == old chars/4 (byte-identical, no blast radius)", () => {
    for (const s of [
      "",
      "a",
      "the quick brown fox jumps over the lazy dog",
      "function foo(x) { return x * 4 + 1 }\n".repeat(50),
      "1234567890!@#$%^&*()_+-=[]{};':\",./<>?",
    ]) {
      expect(ToolBudget.estimateTokens(s)).toBe(legacyDiv4(s))
    }
  })

  it("pure CJK ≈ 1 token/char — far above chars/4", () => {
    const cjk = "字".repeat(1000)
    expect(ToolBudget.estimateTokens(cjk)).toBe(1000)
    expect(legacyDiv4(cjk)).toBe(250)
    expect(ToolBudget.estimateTokens(cjk)).toBeGreaterThan(legacyDiv4(cjk) * 3.5)
  })

  it("covers Han, Hiragana/Katakana, Hangul, fullwidth", () => {
    expect(ToolBudget.estimateTokens("你好世界")).toBe(4) // Han
    expect(ToolBudget.estimateTokens("あいうえお")).toBe(5) // hiragana
    expect(ToolBudget.estimateTokens("カタカナ")).toBe(4) // katakana
    expect(ToolBudget.estimateTokens("한국어")).toBe(3) // hangul
    expect(ToolBudget.estimateTokens("ＡＢＣ")).toBe(3) // fullwidth latin
  })

  it("astral CJK ext-B counts ~1 token/char (high surrogate)", () => {
    // each ext-B char = surrogate pair: high surrogate (+1 cjk) + low surrogate (other)
    const s = "\u{20000}\u{20001}" // 2 chars, 4 code units
    // 2 high surrogates (=2) + 2 low surrogates (ceil(2/4)=1) = 3
    expect(ToolBudget.estimateTokens(s)).toBe(3)
    expect(ToolBudget.estimateTokens(s)).toBeGreaterThan(legacyDiv4(s)) // > chars/4 (=1)
  })

  it("mixed CJK + ASCII: CJK at 1 tok, ASCII at /4", () => {
    // 4 Han (=4) + 8 ASCII (ceil(8/4)=2) = 6
    expect(ToolBudget.estimateTokens("你好世界abcdefgh")).toBe(6)
  })

  it("reproduces the real anchor magnitude (~60% CJK 243K chars → ~170K, not ~60K)", () => {
    // 146000 Han + 97000 ASCII ≈ the poisoned-session anchor
    const body = "字".repeat(146_000) + "x".repeat(97_000)
    const est = ToolBudget.estimateTokens(body)
    expect(est).toBeGreaterThan(160_000)
    expect(est).toBeLessThan(190_000)
    expect(legacyDiv4(body)).toBeLessThan(65_000) // old undercount
  })
})
