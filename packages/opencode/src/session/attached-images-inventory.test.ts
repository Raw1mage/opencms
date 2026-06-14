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
    // Consume-on-use framing: shown THIS turn, drops to a link next turn —
    // no "persists across turns" claim.
    expect(out).toContain("Shown in full this turn (recognition pass): a.png, c.png")
    expect(out).not.toContain("persists across turns")
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

  // BR 2026-06-14: turn-scope signal. When the caller supplies message roles,
  // each image is attributed to a turn so a historical upload can't be mistaken
  // for this turn's input (the "phantom attachment" regression after compaction).
  const userMsg = (parts: InventoryAttachmentLike[]): InventoryMessageLike => ({ info: { role: "user" }, parts })
  const asstMsg = (): InventoryMessageLike => ({ info: { role: "assistant" }, parts: [] })

  it("marks a historical image as earlier/not-this-turn when the current turn is pure text", () => {
    const messages: InventoryMessageLike[] = [
      userMsg([img("old.png")]), // attached 1 user-turn ago
      asstMsg(),
      userMsg([{ type: "text" } as InventoryAttachmentLike]), // current turn: pure text
    ]
    const out = buildAttachedImagesInventory(messages)
    expect(out).toContain("- old.png (image/png) — earlier, 1 turn(s) ago, not this turn")
    expect(out).toContain("TURN SCOPE: none of these were attached in the current message")
    expect(out).not.toContain("[THIS TURN]")
  })

  it("marks the current-turn upload [THIS TURN] and earlier ones as earlier", () => {
    const messages: InventoryMessageLike[] = [
      userMsg([img("hist.png")]),
      asstMsg(),
      userMsg([img("fresh.png")]), // current turn
    ]
    const out = buildAttachedImagesInventory(messages)
    expect(out).toContain("- fresh.png (image/png) [THIS TURN]")
    expect(out).toContain("- hist.png (image/png) — earlier, 1 turn(s) ago, not this turn")
    expect(out).toContain("TURN SCOPE: only entries marked [THIS TURN] were attached in the current message")
  })

  it("omits turn-scope annotations entirely when no roles are supplied (legacy callers)", () => {
    const out = buildAttachedImagesInventory([{ parts: [img("a.png")] }])
    expect(out).not.toContain("TURN SCOPE")
    expect(out).not.toContain("[THIS TURN]")
    expect(out).not.toContain("not this turn")
    expect(out).toContain("- a.png (image/png)")
  })
})
