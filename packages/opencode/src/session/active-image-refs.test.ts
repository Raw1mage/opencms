import {
  ACTIVE_IMAGE_REFS_DEFAULT_MAX,
  addOnReread,
  addOnUpload,
  addOnUploadGated,
  drainAfterAssistant,
  type AttachmentRefLike,
} from "./active-image-refs"

const imagePart = (filename: string, repo_path = `incoming/${filename}`, mime = "image/png"): AttachmentRefLike => ({
  type: "attachment_ref",
  mime,
  filename,
  repo_path,
})

describe("addOnUpload", () => {
  it("returns prior unchanged when message has no parts", () => {
    expect(addOnUpload(["a.png"], [])).toEqual(["a.png"])
  })

  it("ignores non-image parts", () => {
    const parts: AttachmentRefLike[] = [
      { type: "text" },
      { type: "attachment_ref", mime: "application/pdf", filename: "doc.pdf", repo_path: "incoming/doc.pdf" },
    ]
    expect(addOnUpload([], parts)).toEqual([])
  })

  it("skips image attachment_ref without repo_path (legacy/inline)", () => {
    const parts = [{ type: "attachment_ref", mime: "image/png", filename: "x.png" } as AttachmentRefLike]
    expect(addOnUpload([], parts)).toEqual([])
  })

  it("appends inline-eligible images preserving prior order", () => {
    expect(addOnUpload(["a.png"], [imagePart("b.png")])).toEqual(["a.png", "b.png"])
  })

  it("dedups by filename against prior set", () => {
    expect(addOnUpload(["a.png"], [imagePart("a.png")])).toEqual(["a.png"])
  })

  it("dedups within a single message", () => {
    expect(addOnUpload([], [imagePart("a.png"), imagePart("a.png")])).toEqual(["a.png"])
  })

  it("applies FIFO cap when prior + new exceed the max", () => {
    const prior = ["a.png", "b.png", "c.png"]
    const parts = [imagePart("d.png")]
    expect(addOnUpload(prior, parts, { max: 3 })).toEqual(["b.png", "c.png", "d.png"])
  })

  it("default cap is ACTIVE_IMAGE_REFS_DEFAULT_MAX", () => {
    expect(ACTIVE_IMAGE_REFS_DEFAULT_MAX).toBe(3)
    const parts = [imagePart("a.png"), imagePart("b.png"), imagePart("c.png"), imagePart("d.png")]
    expect(addOnUpload([], parts)).toEqual(["b.png", "c.png", "d.png"])
  })
})

describe("isInlineableImage via addOnUpload (session_path acceptance)", () => {
  it("accepts a modern upload that carries session_path but no repo_path", () => {
    const parts = [
      {
        type: "attachment_ref",
        mime: "image/png",
        filename: "shot.png",
        session_path: "sessions/ses_x/attachments/shot.png",
      } as AttachmentRefLike,
    ]
    expect(addOnUpload([], parts)).toEqual(["shot.png"])
  })
})

describe("addOnUploadGated", () => {
  const img = (filename: string, est_tokens: number): AttachmentRefLike => ({
    type: "attachment_ref",
    mime: "image/png",
    filename,
    session_path: `sessions/ses_x/attachments/${filename}`,
    est_tokens,
  })

  it("auto-queues a single small upload within budget", () => {
    expect(addOnUploadGated([], [img("a.png", 11469)], { budgetTokens: 20000 })).toEqual(["a.png"])
  })

  it("auto-queues two small uploads whose combined est is within budget", () => {
    expect(addOnUploadGated([], [img("a.png", 8000), img("b.png", 8000)], { budgetTokens: 20000 })).toEqual([
      "a.png",
      "b.png",
    ])
  })

  it("leaves a big dump on the opt-in path (returns prior unchanged) when combined est exceeds budget", () => {
    const parts = [img("a.png", 9000), img("b.png", 9000), img("c.png", 9000)]
    const prior: string[] = []
    const out = addOnUploadGated(prior, parts, { budgetTokens: 20000 })
    expect(out).toBe(prior)
  })

  it("is all-or-nothing: a single over-budget image queues nothing", () => {
    expect(addOnUploadGated([], [img("huge.png", 50000)], { budgetTokens: 20000 })).toEqual([])
  })

  it("budgetTokens <= 0 disables auto-inline entirely (pure opt-in)", () => {
    expect(addOnUploadGated([], [img("a.png", 100)], { budgetTokens: 0 })).toEqual([])
  })

  it("treats missing est_tokens as 0 so it stays within budget", () => {
    const part = { type: "attachment_ref", mime: "image/png", filename: "a.png", session_path: "s/a.png" } as AttachmentRefLike
    expect(addOnUploadGated([], [part], { budgetTokens: 1 })).toEqual(["a.png"])
  })

  it("dedups against the prior active set", () => {
    expect(addOnUploadGated(["a.png"], [img("a.png", 100)], { budgetTokens: 20000 })).toEqual(["a.png"])
  })

  it("returns prior unchanged when no fresh inline-eligible image is present", () => {
    const prior = ["a.png"]
    expect(addOnUploadGated(prior, [{ type: "text" } as AttachmentRefLike], { budgetTokens: 20000 })).toBe(prior)
  })

  it("applies FIFO cap on the combined set", () => {
    const out = addOnUploadGated(["a.png", "b.png"], [img("c.png", 100), img("d.png", 100)], {
      max: 3,
      budgetTokens: 20000,
    })
    expect(out).toEqual(["b.png", "c.png", "d.png"])
  })
})

describe("addOnReread", () => {
  it("appends filename to active set", () => {
    expect(addOnReread([], "x.png")).toEqual(["x.png"])
  })

  it("noop when filename already active", () => {
    expect(addOnReread(["x.png"], "x.png")).toEqual(["x.png"])
  })

  it("applies FIFO cap", () => {
    expect(addOnReread(["a.png", "b.png", "c.png"], "d.png", { max: 3 })).toEqual(["b.png", "c.png", "d.png"])
  })
})

describe("drainAfterAssistant", () => {
  it("returns empty next + drained list", () => {
    expect(drainAfterAssistant(["a.png", "b.png"])).toEqual({
      drained: ["a.png", "b.png"],
      next: [],
    })
  })

  it("safe on undefined prior", () => {
    expect(drainAfterAssistant(undefined)).toEqual({ drained: [], next: [] })
  })

  it("clears even when active set is non-empty after weird finish state (R9 mitigation)", () => {
    const result = drainAfterAssistant(["x.png"])
    expect(result.next).toEqual([])
  })
})
