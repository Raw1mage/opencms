import { describe, expect, it } from "bun:test"

import {
  buildAttachedImagesInventory,
  type InventoryAttachmentLike,
  type InventoryMessageLike,
} from "./attached-images-inventory"

const img = (
  filename: string,
  storage: "session" | "repo" = "session",
  extra: Partial<InventoryAttachmentLike> = {},
): InventoryAttachmentLike => ({
  type: "attachment_ref",
  mime: "image/png",
  filename,
  ...(storage === "session" ? { session_path: `sessions/sid/attachments/${filename}` } : { repo_path: `incoming/${filename}` }),
  ...extra,
})

describe("buildAttachedImagesInventory (v5 DD-22.1)", () => {
  it("returns empty string when 0 images in session", () => {
    const messages: InventoryMessageLike[] = [{ parts: [{ type: "text" } as InventoryAttachmentLike] }]
    expect(buildAttachedImagesInventory(messages)).toBe("")
  })

  it("returns empty string when only non-image attachment_refs exist", () => {
    const messages = [
      {
        parts: [{ type: "attachment_ref", mime: "application/pdf", filename: "doc.pdf", session_path: "x" }],
      },
    ]
    expect(buildAttachedImagesInventory(messages)).toBe("")
  })

  it("returns inventory listing one image with storage path populated", () => {
    const out = buildAttachedImagesInventory([{ parts: [img("screenshot.png")] }])
    expect(out).toContain('<attached_images count="1">')
    expect(out).toContain("- screenshot.png (image/png)")
    // No active set → emits the imperative usage block.
    expect(out).toContain("filesystem tools (read / grep / glob) CANNOT decode image bytes")
    expect(out).toContain("reread_attachment()")
    expect(out).toContain("</attached_images>")
  })

  it("walks newest-first and deduplicates by filename", () => {
    const messages = [
      { parts: [img("a.png")] },
      { parts: [img("b.png"), img("a.png", "session", { session_path: "sessions/sid/attachments/a-newer.png" })] },
    ]
    const out = buildAttachedImagesInventory(messages)
    const lines = out.split("\n").filter((l) => l.startsWith("- "))
    expect(lines).toEqual(["- b.png (image/png)", "- a.png (image/png)"])
  })

  it("annotates active inline when activeImageRefs intersects", () => {
    const messages = [{ parts: [img("a.png"), img("b.png"), img("c.png")] }]
    const out = buildAttachedImagesInventory(messages, { activeImageRefs: ["a.png", "c.png"] })
    expect(out).toContain("Active inline (pixels available in this preface, persists across turns): a.png, c.png")
    // Inventory entries get [ACTIVE] tag.
    expect(out).toContain("- a.png [ACTIVE]")
    expect(out).toContain("- c.png [ACTIVE]")
    expect(out).toContain("- b.png (image/png)")
  })

  it("renders dimensions and byte_size when populated", () => {
    const messages = [{ parts: [img("hd.png", "session", { dimensions: { w: 1920, h: 1080 }, byte_size: 524288 })] }]
    const out = buildAttachedImagesInventory(messages)
    expect(out).toContain("- hd.png (image/png, 1920×1080, 512.0 KB)")
  })

  it("counts 50 images and emits inventory under ~5KB", () => {
    const parts = Array.from({ length: 50 }, (_, i) => img(`bug-${i}.png`))
    const out = buildAttachedImagesInventory([{ parts }])
    expect(out).toContain('<attached_images count="50">')
    expect(out.length).toBeLessThan(5000)
  })

  it("works with repo_path-only legacy refs", () => {
    const out = buildAttachedImagesInventory([{ parts: [img("legacy.png", "repo")] }])
    expect(out).toContain("- legacy.png (image/png)")
  })

  it("skips parts with neither session_path nor repo_path", () => {
    const messages = [
      {
        parts: [{ type: "attachment_ref", mime: "image/png", filename: "stale.png" } as InventoryAttachmentLike],
      },
    ]
    expect(buildAttachedImagesInventory(messages)).toBe("")
  })
})
