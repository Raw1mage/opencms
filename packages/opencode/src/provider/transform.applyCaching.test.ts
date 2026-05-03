import { describe, it, expect } from "bun:test"
import { ProviderTransform } from "./transform"
import type { ModelMessage } from "ai"

const BP_KEY = ProviderTransform.PHASE_B_BREAKPOINT_PROVIDER_OPTION

function block(text: string, mark = false) {
  const opts: any = mark ? { [BP_KEY]: true } : {}
  return { type: "text" as const, text, providerOptions: opts }
}

function countCacheControlMarks(msgs: ModelMessage[]): number {
  let count = 0
  for (const m of msgs) {
    if (!Array.isArray(m.content)) {
      if ((m.providerOptions as any)?.anthropic?.cacheControl) count++
      continue
    }
    for (const b of m.content) {
      if (b && typeof b === "object" && (b.providerOptions as any)?.anthropic?.cacheControl) count++
    }
  }
  return count
}

function isMarked(content: unknown): boolean {
  return !!(content as any)?.providerOptions?.anthropic?.cacheControl
}

describe("applyCaching — Phase B 4-breakpoint allocator (DD-3)", () => {
  describe("Phase A baseline (no preface marks)", () => {
    it("legacy 2-BP behavior preserved: marks last system + last non-system", () => {
      const msgs: ModelMessage[] = [
        { role: "system", content: [block("static")] },
        { role: "user", content: [block("hi")] },
        { role: "assistant", content: [block("ok")] },
      ]
      ProviderTransform.applyCaching(msgs, "anthropic")
      expect(countCacheControlMarks(msgs)).toBeGreaterThanOrEqual(2)
    })
  })

  describe("Phase B with preface (full T1 + T2 + trailing)", () => {
    it("emits 4 BPs total: BP1 system + BP2 t1-end + BP3 t2-end + BP4 user-end (trailing rides BP4)", () => {
      const msgs: ModelMessage[] = [
        { role: "system", content: [block("static-system-block")] },
        {
          role: "user",
          content: [
            block("preface-t1-content", true),       // BP2: explicit mark
            block("preface-t2-content", true),       // BP3: explicit mark
            block("preface-trailing-content", false),// rides BP4 via user msg
          ],
        },
        { role: "user", content: [block("user typed text")] }, // BP4: legacy "last non-system"
      ]
      ProviderTransform.applyCaching(msgs, "anthropic")
      expect(countCacheControlMarks(msgs)).toBe(4)
      expect(isMarked(msgs[1].content[0])).toBe(true)  // t1 end
      expect(isMarked(msgs[1].content[1])).toBe(true)  // t2 end
      expect(isMarked(msgs[1].content[2])).toBe(false) // trailing not directly
      expect(isMarked(msgs[2].content[0])).toBe(true)  // BP4 user end
    })

    it("system message also gets BP1 (last content block of static system)", () => {
      const msgs: ModelMessage[] = [
        { role: "system", content: [block("static")] },
        { role: "user", content: [block("preface-t1", true)] },
        { role: "user", content: [block("user")] },
      ]
      ProviderTransform.applyCaching(msgs, "anthropic")
      expect(isMarked(msgs[0].content[0])).toBe(true) // BP1
    })
  })

  describe("Phase B with preface T1 only (T2 empty)", () => {
    it("emits 3 BPs: BP1 + BP2 + BP4 (BP3 omitted, not relocated)", () => {
      const msgs: ModelMessage[] = [
        { role: "system", content: [block("static")] },
        { role: "user", content: [block("preface-t1-only", true)] },
        { role: "user", content: [block("user typed")] },
      ]
      ProviderTransform.applyCaching(msgs, "anthropic")
      expect(countCacheControlMarks(msgs)).toBe(3)
    })
  })

  describe("Phase B does NOT double-mark when preface t2-end is also msg-end", () => {
    it("preface with t1+t2 (no trailing): t2 block gets exactly one cache_control", () => {
      const msgs: ModelMessage[] = [
        { role: "system", content: [block("static")] },
        {
          role: "user",
          content: [
            block("preface-t1", true),
            block("preface-t2", true), // also last block of msg → legacy rule would also pick this
          ],
        },
        { role: "user", content: [block("user")] },
      ]
      ProviderTransform.applyCaching(msgs, "anthropic")
      // Total 4 BPs: BP1 system + BP2 t1 + BP3 t2 + BP4 user-end. The
      // preface message's last block is t2 — legacy "last non-system" rule
      // is skipped for preface (hasPhaseBPrefaceMarks short-circuits) so
      // only the explicit BP3 mark fires on that block. mergeDeep would
      // dedupe in either case but skip prevents double counting.
      expect(countCacheControlMarks(msgs)).toBe(4)
      expect(isMarked(msgs[1].content[1])).toBe(true)
    })
  })

  describe("works with multiple cache providers", () => {
    it("openrouter receives cacheControl too", () => {
      const msgs: ModelMessage[] = [
        { role: "system", content: [block("static")] },
        { role: "user", content: [block("preface", true)] },
        { role: "user", content: [block("user")] },
      ]
      ProviderTransform.applyCaching(msgs, "openrouter")
      const opt = msgs[1].content[0].providerOptions as any
      expect(opt?.openrouter?.cacheControl).toBeTruthy()
    })

    it("openaiCompatible uses snake_case cache_control", () => {
      const msgs: ModelMessage[] = [
        { role: "system", content: [block("static")] },
        { role: "user", content: [block("preface", true)] },
        { role: "user", content: [block("user")] },
      ]
      ProviderTransform.applyCaching(msgs, "openaiCompatible")
      const opt = msgs[1].content[0].providerOptions as any
      expect(opt?.openaiCompatible?.cache_control).toBeTruthy()
    })
  })

  describe("bedrock fallback (message-level not block-level)", () => {
    it("bedrock skips Phase B explicit block marks (uses message-level only)", () => {
      const msgs: ModelMessage[] = [
        { role: "system", content: [block("static")] },
        {
          role: "user",
          content: [block("preface-t1", true), block("preface-t2", true)],
        },
        { role: "user", content: [block("user")] },
      ]
      ProviderTransform.applyCaching(msgs, "bedrock")
      // bedrock route uses message-level providerOptions, not block-level.
      // Expect message-level cachePoint on system and user msgs.
      const sysOpt = msgs[0].providerOptions as any
      expect(sysOpt?.bedrock?.cachePoint).toBeTruthy()
      const userOpt = msgs[2].providerOptions as any
      expect(userOpt?.bedrock?.cachePoint).toBeTruthy()
    })
  })
})
