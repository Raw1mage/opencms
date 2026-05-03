import {
  ACTIVE_IMAGE_REFS_DEFAULT_MAX,
  addOnReread,
  addOnUpload,
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
