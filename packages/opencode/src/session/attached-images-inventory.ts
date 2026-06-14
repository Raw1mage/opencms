/**
 * attachment-lifecycle v5 (DD-22.1): build the `<attached_images>` text
 * inventory placed in the preface trailing tier (BP4 zone). Tells the
 * AI which session-attached images exist, which (if any) are currently
 * inlined this turn, and — when message roles are supplied — which were
 * attached in the current turn vs earlier (BR 2026-06-14: turn-scope
 * signal so a historical filename is not mistaken for a fresh upload).
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
  /**
   * Message role, when the caller can supply it. Used to attribute each image
   * to a conversation turn so the inventory can mark this-turn uploads vs
   * earlier ones. Optional: legacy callers that omit it get the un-annotated
   * listing (backward compatible).
   */
  info?: { role?: string }
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
  const ordered: Array<{ part: InventoryAttachmentLike; sourceIdx: number }> = []
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi]
    for (const part of msg?.parts ?? []) {
      if (part.type !== "attachment_ref") continue
      if (!part.filename) continue
      if (!part.mime?.startsWith("image/")) continue
      if (!part.repo_path && !part.session_path) continue
      if (seen.has(part.filename)) continue
      seen.add(part.filename)
      ordered.push({ part, sourceIdx: mi })
    }
  }

  if (ordered.length === 0) return ""

  // Turn attribution (BR 2026-06-14): without a turn signal a historical bare
  // filename reads like a fresh upload — after compaction drops the original
  // request's context, the model re-derives the listed image as "the user just
  // pasted this". Identify the current user turn (last user message) so each
  // image can be marked this-turn vs earlier. Only available when the caller
  // supplies message roles (the production path); legacy callers without roles
  // get the un-annotated listing.
  const userIdxs: number[] = []
  for (let mi = 0; mi < messages.length; mi++) {
    if (messages[mi]?.info?.role === "user") userIdxs.push(mi)
  }
  const hasTurnInfo = userIdxs.length > 0
  const currentUserIdx = hasTurnInfo ? userIdxs[userIdxs.length - 1] : -1
  const turnsAgo = (sourceIdx: number) => userIdxs.filter((i) => i > sourceIdx).length
  const isThisTurn = (sourceIdx: number) => hasTurnInfo && sourceIdx === currentUserIdx
  const freshCount = hasTurnInfo ? ordered.filter((o) => isThisTurn(o.sourceIdx)).length : 0

  const active = new Set(options.activeImageRefs ?? [])
  const activeNames = ordered.map((o) => o.part.filename!).filter((name) => active.has(name))
  const lines: string[] = []
  lines.push(`<attached_images count="${ordered.length}">`)
  // Imperative usage block first — model reads top-down, the directive
  // belongs above the inventory listing so the read-pattern is
  // "see the rule, then see what's available".
  if (activeNames.length === 0) {
    lines.push(
      `IMPORTANT: filesystem tools (read / grep / glob) CANNOT decode image bytes. ` +
        `To view an image listed below, call reread_attachment() with no arguments ` +
        `for the most recent one, or reread_attachment(filename="...") for a specific one. ` +
        `Pixels appear in your NEXT response for that ONE turn, then drop back to a link here; ` +
        `your written analysis of them persists in the conversation. ` +
        `Call again only when you need to RE-EXAMINE the actual pixels — not to keep seeing an image you already described.`,
    )
  } else {
    lines.push(
      `Shown in full this turn (recognition pass): ${activeNames.join(", ")}. ` +
        `Capture what you need now — next turn these drop back to on-demand links below ` +
        `(call reread_attachment to view again). The written description persists; the pixels do not.`,
    )
  }
  // Turn-scope directive: make the history-vs-fresh distinction explicit so the
  // model never mistakes an earlier upload for this turn's input.
  if (hasTurnInfo) {
    if (freshCount === 0) {
      lines.push(
        `TURN SCOPE: none of these were attached in the current message — they are earlier uploads ` +
          `in this conversation, listed only so you can reread them on demand. Do NOT start analyzing ` +
          `one (or say "let me look at the image you pasted") unless the user refers to it this turn.`,
      )
    } else {
      lines.push(
        `TURN SCOPE: only entries marked [THIS TURN] were attached in the current message; ` +
          `the rest are earlier uploads — do not treat them as new input.`,
      )
    }
  }
  lines.push(`Inventory:`)
  for (const { part, sourceIdx } of ordered) {
    const activeTag = active.has(part.filename!) ? " [ACTIVE]" : ""
    let freshness = ""
    if (hasTurnInfo) {
      freshness = isThisTurn(sourceIdx)
        ? " [THIS TURN]"
        : ` — earlier, ${turnsAgo(sourceIdx)} turn(s) ago, not this turn`
    }
    lines.push(`- ${part.filename}${activeTag} (${describePart(part)})${freshness}`)
  }
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
