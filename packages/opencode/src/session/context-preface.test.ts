import { describe, it, expect } from "bun:test"
import { buildPreface } from "./context-preface"
import { PREFACE_DIRECTIVE_HEADER, CONTEXT_PREFACE_KIND } from "./context-preface-types"

const baseInput = {
  preload: { readmeSummary: "README content", cwdListing: "fileA\nfileB" },
  skills: {
    pinned: [{ name: "frontend", state: "pinned" as const, content: "frontend body" }],
    active: [{ name: "bash-toolkit", state: "active" as const, content: "bash body" }],
    summarized: [{ name: "legacy-helper", state: "summary" as const, content: "purpose: X" }],
  },
  todaysDate: "Sun May 04 2026",
}

describe("buildPreface (DD-1, DD-2, DD-5)", () => {
  describe("structure", () => {
    it("outputs message kind = 'context-preface' (DD-5)", () => {
      const out = buildPreface(baseInput)
      expect(out.kind).toBe(CONTEXT_PREFACE_KIND)
    })

    it("first content block is tier=t1, second is tier=t2 when both present", () => {
      const out = buildPreface(baseInput)
      expect(out.contentBlocks).toHaveLength(2)
      expect(out.contentBlocks[0].tier).toBe("t1")
      expect(out.contentBlocks[1].tier).toBe("t2")
      expect(out.t2Empty).toBe(false)
    })

    it("omits T2 block when both active+summarized are empty", () => {
      const out = buildPreface({
        ...baseInput,
        skills: { pinned: baseInput.skills.pinned, active: [], summarized: [] },
      })
      expect(out.contentBlocks).toHaveLength(1)
      expect(out.contentBlocks[0].tier).toBe("t1")
      expect(out.t2Empty).toBe(true)
    })
  })

  describe("R1 mitigation (directive header)", () => {
    it("T1 always opens with PREFACE_DIRECTIVE_HEADER (baked-in design, not optional)", () => {
      const out = buildPreface(baseInput)
      expect(out.contentBlocks[0].text.startsWith(PREFACE_DIRECTIVE_HEADER)).toBe(true)
    })

    it("directive is present even with all-empty input", () => {
      const out = buildPreface({
        preload: { readmeSummary: "", cwdListing: "" },
        skills: { pinned: [], active: [], summarized: [] },
        todaysDate: "Sun May 04 2026",
      })
      expect(out.contentBlocks[0].text.startsWith(PREFACE_DIRECTIVE_HEADER)).toBe(true)
    })
  })

  describe("DD-2 — date is last in T1", () => {
    it("today's date appears after pinned skills", () => {
      const t1Text = buildPreface(baseInput).contentBlocks[0].text
      const dateIdx = t1Text.indexOf("Today's date:")
      const pinnedIdx = t1Text.indexOf("<pinned_skills>")
      expect(dateIdx).toBeGreaterThan(pinnedIdx)
    })

    it("today's date appears after cwd_listing", () => {
      const t1Text = buildPreface(baseInput).contentBlocks[0].text
      const dateIdx = t1Text.indexOf("Today's date:")
      const cwdIdx = t1Text.indexOf("<cwd_listing>")
      expect(dateIdx).toBeGreaterThan(cwdIdx)
    })

    it("today's date appears after readme_summary", () => {
      const t1Text = buildPreface(baseInput).contentBlocks[0].text
      const dateIdx = t1Text.indexOf("Today's date:")
      const readmeIdx = t1Text.indexOf("<readme_summary>")
      expect(dateIdx).toBeGreaterThan(readmeIdx)
    })
  })

  describe("byte determinism (DD-3 prerequisite for cache hits)", () => {
    it("same input produces byte-equal output across two calls", () => {
      const a = buildPreface(baseInput)
      const b = buildPreface(baseInput)
      expect(a.contentBlocks).toEqual(b.contentBlocks)
      expect(a.parts).toEqual(b.parts)
    })

    it("changing date does not perturb T1 prefix before the date line", () => {
      const a = buildPreface(baseInput)
      const b = buildPreface({ ...baseInput, todaysDate: "Mon May 05 2026" })
      const aT1 = a.contentBlocks[0].text
      const bT1 = b.contentBlocks[0].text
      const aPrefix = aT1.slice(0, aT1.indexOf("Today's date:"))
      const bPrefix = bT1.slice(0, bT1.indexOf("Today's date:"))
      expect(aPrefix).toBe(bPrefix)
    })

    it("changing T2 active skills does not perturb T1 bytes", () => {
      const a = buildPreface(baseInput)
      const b = buildPreface({
        ...baseInput,
        skills: { ...baseInput.skills, active: [] },
      })
      expect(a.contentBlocks[0].text).toBe(b.contentBlocks[0].text)
    })
  })

  describe("tier ordering inside blocks", () => {
    it("T1 order: directive → readme → cwd → pinned → date", () => {
      const t1Text = buildPreface(baseInput).contentBlocks[0].text
      const indices = {
        directive: t1Text.indexOf(PREFACE_DIRECTIVE_HEADER),
        readme: t1Text.indexOf("<readme_summary>"),
        cwd: t1Text.indexOf("<cwd_listing>"),
        pinned: t1Text.indexOf("<pinned_skills>"),
        date: t1Text.indexOf("Today's date:"),
      }
      expect(indices.directive).toBeLessThan(indices.readme)
      expect(indices.readme).toBeLessThan(indices.cwd)
      expect(indices.cwd).toBeLessThan(indices.pinned)
      expect(indices.pinned).toBeLessThan(indices.date)
    })

    it("T2 order: active before summarized", () => {
      const t2Text = buildPreface(baseInput).contentBlocks[1].text
      const activeIdx = t2Text.indexOf("<active_skills>")
      const summaryIdx = t2Text.indexOf("<summarized_skills>")
      expect(activeIdx).toBeGreaterThanOrEqual(0)
      expect(summaryIdx).toBeGreaterThan(activeIdx)
    })
  })
})
