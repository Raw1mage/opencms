import { describe, it, expect } from "bun:test"
import { buildStaticBlock, resolveFamily } from "./static-system-builder"

const baseLayers = {
  driver: "DRIVER_BODY",
  agent: "AGENT_BODY",
  agentsMd: "AGENTS_MD_BODY",
  userSystem: "USER_SYSTEM_BODY",
  systemMd: "SYSTEM_MD_BODY",
  identity: "IDENTITY_BODY",
}

const baseTuple = {
  family: "claude" as const,
  accountId: "claude-acc-A",
  modelId: "claude-sonnet-4-6",
  agentName: "build",
  role: "main" as const,
  layers: baseLayers,
}

describe("buildStaticBlock (DD-12 + DD-3)", () => {
  describe("ordering", () => {
    it("emits layers in DD-12 fixed order (L1→L2→L3c→L5→L6→L7→L8)", () => {
      const out = buildStaticBlock(baseTuple)
      const text = out.text
      const idx = (s: string) => text.indexOf(s)
      expect(idx("DRIVER_BODY")).toBeGreaterThanOrEqual(0)
      expect(idx("DRIVER_BODY")).toBeLessThan(idx("AGENT_BODY"))
      expect(idx("AGENT_BODY")).toBeLessThan(idx("AGENTS_MD_BODY"))
      expect(idx("AGENTS_MD_BODY")).toBeLessThan(idx("USER_SYSTEM_BODY"))
      expect(idx("USER_SYSTEM_BODY")).toBeLessThan(idx("CRITICAL OPERATIONAL BOUNDARY"))
      expect(idx("CRITICAL OPERATIONAL BOUNDARY")).toBeLessThan(idx("SYSTEM_MD_BODY"))
      expect(idx("SYSTEM_MD_BODY")).toBeLessThan(idx("IDENTITY_BODY"))
    })

    it("BOUNDARY always present even when adjacent layers are empty", () => {
      const out = buildStaticBlock({
        ...baseTuple,
        layers: { ...baseLayers, userSystem: "", agentsMd: "" },
      })
      expect(out.text.includes("CRITICAL OPERATIONAL BOUNDARY")).toBe(true)
    })

    it("skips empty layers without disturbing order", () => {
      const out = buildStaticBlock({
        ...baseTuple,
        layers: { ...baseLayers, agent: "", userSystem: "" },
      })
      expect(out.text.includes("AGENT_BODY")).toBe(false)
      expect(out.text.includes("USER_SYSTEM_BODY")).toBe(false)
      expect(out.text.indexOf("DRIVER_BODY")).toBeLessThan(out.text.indexOf("AGENTS_MD_BODY"))
      expect(out.text.indexOf("AGENTS_MD_BODY")).toBeLessThan(out.text.indexOf("CRITICAL OPERATIONAL BOUNDARY"))
    })
  })

  describe("byte determinism (cache key prerequisite)", () => {
    it("same tuple → byte-equal output across two calls", () => {
      const a = buildStaticBlock(baseTuple)
      const b = buildStaticBlock(baseTuple)
      expect(a.text).toBe(b.text)
      expect(a.hash).toBe(b.hash)
    })

    it("hash is sha256 hex (64 chars)", () => {
      const out = buildStaticBlock(baseTuple)
      expect(out.hash).toMatch(/^[a-f0-9]{64}$/)
    })
  })

  describe("hash sensitivity", () => {
    it("changing driver text changes hash", () => {
      const a = buildStaticBlock(baseTuple)
      const b = buildStaticBlock({ ...baseTuple, layers: { ...baseLayers, driver: "DIFFERENT" } })
      expect(a.hash).not.toBe(b.hash)
    })

    it("changing agentsMd changes hash", () => {
      const a = buildStaticBlock(baseTuple)
      const b = buildStaticBlock({ ...baseTuple, layers: { ...baseLayers, agentsMd: "DIFFERENT" } })
      expect(a.hash).not.toBe(b.hash)
    })

    it("changing systemMd changes hash", () => {
      const a = buildStaticBlock(baseTuple)
      const b = buildStaticBlock({ ...baseTuple, layers: { ...baseLayers, systemMd: "DIFFERENT" } })
      expect(a.hash).not.toBe(b.hash)
    })

    // Tuple metadata (family, accountId, modelId, agentName, role) does NOT
    // enter the hash directly because the layers it produces ARE the hash
    // input (driver text differs per family/account; identity differs per
    // role). This test pins that contract so cache identity is byte-driven
    // not metadata-driven.
    it("changing tuple metadata WITHOUT changing layer text does NOT change hash", () => {
      const a = buildStaticBlock(baseTuple)
      const b = buildStaticBlock({
        ...baseTuple,
        family: "codex",
        accountId: "codex-acc-X",
        modelId: "gpt-5",
        agentName: "coding",
        role: "subagent",
      })
      expect(a.hash).toBe(b.hash)
    })
  })

  describe("output struct", () => {
    it("returns text + hash + tuple", () => {
      const out = buildStaticBlock(baseTuple)
      expect(typeof out.text).toBe("string")
      expect(typeof out.hash).toBe("string")
      expect(out.tuple).toEqual(baseTuple)
    })
  })
})

describe("resolveFamily (DD-16)", () => {
  const families = ["claude", "codex", "gemini"] as const

  it("returns family for exact family match", () => {
    expect(resolveFamily("claude", families)).toBe("claude")
  })

  it("returns family for account-id form (family-api-slug)", () => {
    expect(resolveFamily("claude-api-acc-1", families)).toBe("claude")
  })

  it("returns family for subscription form (family-subscription-slug)", () => {
    expect(resolveFamily("codex-subscription-X", families)).toBe("codex")
  })

  it("returns family for provider-instance form (family-slug)", () => {
    expect(resolveFamily("gemini-experimental", families)).toBe("gemini")
  })

  it("throws on unknown providerId (DD-16 fail-loud)", () => {
    expect(() => resolveFamily("anthropic-mystery", families)).toThrow(/cannot resolve family/)
  })

  it("throws on empty providerId", () => {
    expect(() => resolveFamily("", families)).toThrow(/cannot resolve family/)
  })
})
