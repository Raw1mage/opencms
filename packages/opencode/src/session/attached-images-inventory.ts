/**
 * attachment-lifecycle v5 (DD-22.1): build the `<attached_images>` text
 * inventory placed in the preface trailing tier (BP4 zone). Tells the
 * AI which session-attached images exist and which (if any) are
 * currently inlined this turn.
 *
 * Pure function — no I/O. Caller passes the message list + the active
 * set; returns the text block (or empty string when 0 images).
 */

export interface InventoryAttachmentLike {
  type: string
  mime?: string
  filename?: string
  repo_path?: string
  session_path?: string
  dimensions?: { w: number; h: number }
  byte_size?: number
}

export interface InventoryMessageLike {
  parts?: ReadonlyArray<InventoryAttachmentLike>
}

export interface BuildInventoryOptions {
  /** Filenames currently in activeImageRefs (will be inlined this turn). */
  activeImageRefs?: ReadonlyArray<string>
}

/**
 * Walk session messages newest-first; collect inline-eligible image
 * attachment_refs (mime image/* AND a storage path populated). Dedup by
 * filename keeping newest. Emit text block per DD-22.1.
 *
 * Returns "" when 0 images so the caller can omit cleanly without an
 * empty inventory eating tokens.
 */
export function buildAttachedImagesInventory(
  messages: ReadonlyArray<InventoryMessageLike>,
  options: BuildInventoryOptions = {},
): string {
  const seen = new Set<string>()
  const ordered: InventoryAttachmentLike[] = []
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi]
    for (const part of msg?.parts ?? []) {
      if (part.type !== "attachment_ref") continue
      if (!part.filename) continue
      if (!part.mime?.startsWith("image/")) continue
      if (!part.repo_path && !part.session_path) continue
      if (seen.has(part.filename)) continue
      seen.add(part.filename)
      ordered.push(part)
    }
  }

  if (ordered.length === 0) return ""

  const active = new Set(options.activeImageRefs ?? [])
  const lines: string[] = []
  lines.push(`<attached_images count="${ordered.length}">`)
  for (const part of ordered) {
    lines.push(`- ${part.filename} (${describePart(part)})`)
  }
  const activeNames = ordered.map((p) => p.filename!).filter((name) => active.has(name))
  if (activeNames.length === 0) {
    lines.push(`Active in this preface: (none)`)
  } else {
    lines.push(`Active in this preface: ${activeNames.join(", ")}`)
  }
  lines.push(`Use reread_attachment(filename) to bring an image into your next response.`)
  lines.push(`</attached_images>`)
  return lines.join("\n")
}

function describePart(part: InventoryAttachmentLike): string {
  const bits: string[] = []
  if (part.mime) bits.push(part.mime)
  if (part.dimensions) bits.push(`${part.dimensions.w}×${part.dimensions.h}`)
  if (part.byte_size && part.byte_size > 0) bits.push(humanBytes(part.byte_size))
  return bits.join(", ")
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
