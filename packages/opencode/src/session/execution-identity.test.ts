import { shouldResumeDrainImages } from "./active-image-refs"
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

describe("shouldResumeDrainImages (BR restart-resume-not-draining-active-image)", () => {
  it("drains on first touch when a stale active set survived the restart", () => {
    const seen = new Set<string>()
    expect(shouldResumeDrainImages(seen, "ses_a", ["stale.png"])).toBe(true)
  })

  it("does not drain a session already seen this process (once-only)", () => {
    const seen = new Set<string>(["ses_a"])
    expect(shouldResumeDrainImages(seen, "ses_a", ["stale.png"])).toBe(false)
  })

  it("no-op when there is no active set to drain", () => {
    const seen = new Set<string>()
    expect(shouldResumeDrainImages(seen, "ses_a", [])).toBe(false)
    expect(shouldResumeDrainImages(seen, "ses_a", undefined)).toBe(false)
  })

  it("models the caller's add-after-check contract: drain once, then never again", () => {
    // Mirror pinExecutionIdentity: decide, then mark seen unconditionally.
    const seen = new Set<string>()
    const refs: string[] | undefined = ["stale.png"]
    const decisions: boolean[] = []
    for (let touch = 0; touch < 3; touch++) {
      decisions.push(shouldResumeDrainImages(seen, "ses_a", touch === 0 ? refs : []))
      seen.add("ses_a")
    }
    // Only the first touch drains; subsequent touches are suppressed by `seen`.
    expect(decisions).toEqual([true, false, false])
  })
})
