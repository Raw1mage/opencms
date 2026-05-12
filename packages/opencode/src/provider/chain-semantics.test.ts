import { describe, expect, it } from "bun:test"
import {
  assertAllProvidersClassified,
  classifyProvider,
  getChainSemanticsSnapshot,
  ProviderChainClassSchema,
  ProviderChainSemanticsMissingError,
  type ProviderChainClass,
} from "./chain-semantics"
import { SUPPORTED_PROVIDER_KEYS } from "./supported-provider-registry"

describe("provider/chain-semantics", () => {
  describe("classifyProvider", () => {
    it("classifies codex as SS (canonical stateful provider)", () => {
      expect(classifyProvider("codex")).toBe("SS")
    })

    it("classifies openai as SS (Responses API)", () => {
      expect(classifyProvider("openai")).toBe("SS")
    })

    it("classifies github-copilot as SS (DD-6: Responses API surface, stateless reasoning is rendering fallback only)", () => {
      expect(classifyProvider("github-copilot")).toBe("SS")
    })

    it("classifies claude-cli as SL (anthropic stateless)", () => {
      expect(classifyProvider("claude-cli")).toBe("SL")
    })

    it("classifies google-api as SL", () => {
      expect(classifyProvider("google-api")).toBe("SL")
    })

    it("classifies gemini-cli as SL", () => {
      expect(classifyProvider("gemini-cli")).toBe("SL")
    })

    it("classifies openrouter as SL (proxy via stateless surface)", () => {
      expect(classifyProvider("openrouter")).toBe("SL")
    })

    it("classifies vercel as SL", () => {
      expect(classifyProvider("vercel")).toBe("SL")
    })

    it("classifies gitlab as SL", () => {
      expect(classifyProvider("gitlab")).toBe("SL")
    })

    it("classifies gmicloud as SL", () => {
      expect(classifyProvider("gmicloud")).toBe("SL")
    })

    it("classifies opencode as SL", () => {
      expect(classifyProvider("opencode")).toBe("SL")
    })

    it("throws ProviderChainSemanticsMissingError for unknown providerId (DD-11: no silent default)", () => {
      expect(() => classifyProvider("unknown-future-provider")).toThrow(ProviderChainSemanticsMissingError)
    })

    it("throws with payload containing the offending providerId", () => {
      try {
        classifyProvider("rogue-provider-xyz")
        throw new Error("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderChainSemanticsMissingError)
        const named = err as InstanceType<typeof ProviderChainSemanticsMissingError>
        expect(named.data.providerId).toBe("rogue-provider-xyz")
      }
    })
  })

  describe("assertAllProvidersClassified", () => {
    it("does not throw — every SUPPORTED_PROVIDER_KEY is classified", () => {
      expect(() => assertAllProvidersClassified()).not.toThrow()
    })

    it("covers every SUPPORTED_PROVIDER_KEY (structural assertion)", () => {
      const snapshot = getChainSemanticsSnapshot()
      for (const key of SUPPORTED_PROVIDER_KEYS) {
        expect(snapshot).toHaveProperty(key)
      }
    })

    it("classifies every key into a known ProviderChainClass value", () => {
      const snapshot = getChainSemanticsSnapshot()
      const valid = new Set<ProviderChainClass>(["SS", "SL", "Hybrid"])
      for (const [providerId, klass] of Object.entries(snapshot)) {
        expect(valid.has(klass)).toBe(true)
        if (!valid.has(klass)) {
          throw new Error(`provider ${providerId} has invalid class ${klass}`)
        }
      }
    })
  })

  describe("ProviderChainClassSchema", () => {
    it("accepts SS / SL / Hybrid", () => {
      expect(ProviderChainClassSchema.safeParse("SS").success).toBe(true)
      expect(ProviderChainClassSchema.safeParse("SL").success).toBe(true)
      expect(ProviderChainClassSchema.safeParse("Hybrid").success).toBe(true)
    })

    it("rejects unknown values", () => {
      expect(ProviderChainClassSchema.safeParse("Stateful").success).toBe(false)
      expect(ProviderChainClassSchema.safeParse("").success).toBe(false)
    })
  })

  describe("invariants", () => {
    it("snapshot is immutable (frozen)", () => {
      const snapshot = getChainSemanticsSnapshot()
      expect(Object.isFrozen(snapshot)).toBe(true)
    })

    it("at least one SS and at least one SL provider exist — registry isn't degenerate", () => {
      const values = Object.values(getChainSemanticsSnapshot())
      expect(values).toContain("SS" as ProviderChainClass)
      expect(values).toContain("SL" as ProviderChainClass)
    })
  })
})
