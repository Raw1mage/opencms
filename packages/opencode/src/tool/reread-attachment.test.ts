import { describe, expect, it } from "bun:test"

import { findInlineableAttachment } from "./reread-attachment"

const imagePart = (filename: string) => ({
  type: "attachment_ref",
  mime: "image/png",
  filename,
  repo_path: `incoming/${filename}`,
})

describe("findInlineableAttachment (T.3 voucher tool)", () => {
  it("returns undefined when no messages", () => {
    expect(findInlineableAttachment([], "x.png")).toBeUndefined()
  })

  it("returns undefined when filename does not match", () => {
    const messages = [{ parts: [imagePart("a.png")] }]
    expect(findInlineableAttachment(messages, "b.png")).toBeUndefined()
  })

  it("returns the matching attachment when filename matches", () => {
    const messages = [{ parts: [imagePart("doc.png")] }]
    const found = findInlineableAttachment(messages, "doc.png")
    expect(found).toBeDefined()
    expect(found?.filename).toBe("doc.png")
    expect(found?.repo_path).toBe("incoming/doc.png")
  })

  it("skips parts without repo_path (legacy/inline)", () => {
    const messages = [
      {
        parts: [
          { type: "attachment_ref", mime: "image/png", filename: "legacy.png" },
        ],
      },
    ]
    expect(findInlineableAttachment(messages, "legacy.png")).toBeUndefined()
  })

  it("skips non-image mime even when repo_path present", () => {
    const messages = [
      {
        parts: [
          { type: "attachment_ref", mime: "application/pdf", filename: "doc.pdf", repo_path: "incoming/doc.pdf" },
        ],
      },
    ]
    expect(findInlineableAttachment(messages, "doc.pdf")).toBeUndefined()
  })

  it("walks newest-first and returns most recent match across multiple messages", () => {
    const messages = [
      { parts: [{ ...imagePart("img.png"), repo_path: "incoming/img-OLD.png" }] },
      { parts: [{ ...imagePart("img.png"), repo_path: "incoming/img-NEW.png" }] },
    ]
    const found = findInlineableAttachment(messages, "img.png")
    expect(found?.repo_path).toBe("incoming/img-NEW.png")
  })
})
