import { Session } from "./index"

describe("ExecutionIdentity schema (DD-20: activeImageRefs)", () => {
  const base = {
    providerId: "anthropic",
    modelID: "claude-opus-4-7",
    revision: 0,
    updatedAt: 1730000000000,
  }

  it("parses absent activeImageRefs (legacy session)", () => {
    const out = Session.ExecutionIdentity.parse(base)
    expect(out.activeImageRefs).toBeUndefined()
  })

  it("parses empty activeImageRefs array", () => {
    const out = Session.ExecutionIdentity.parse({ ...base, activeImageRefs: [] })
    expect(out.activeImageRefs).toEqual([])
  })

  it("parses single-entry activeImageRefs", () => {
    const out = Session.ExecutionIdentity.parse({ ...base, activeImageRefs: ["screenshot.png"] })
    expect(out.activeImageRefs).toEqual(["screenshot.png"])
  })

  it("parses multi-entry activeImageRefs preserving order", () => {
    const out = Session.ExecutionIdentity.parse({
      ...base,
      activeImageRefs: ["a.png", "b.jpg", "c.webp"],
    })
    expect(out.activeImageRefs).toEqual(["a.png", "b.jpg", "c.webp"])
  })

  it("rejects non-string entries", () => {
    expect(() =>
      Session.ExecutionIdentity.parse({ ...base, activeImageRefs: [123] as unknown as string[] }),
    ).toThrow()
  })
})
