/**
 * attachment-lifecycle v4 (DD-20): pure helpers that compute the next value
 * of `Session.ExecutionIdentity.activeImageRefs`.
 *
 * Active set = filenames of image attachments that should be inlined into the
 * NEXT preface trailing tier (BP4 zone). Drained after every assistant
 * `finish="stop"` so the set never accumulates across turns.
 *
 * These helpers are intentionally schema-agnostic — they accept a structural
 * part shape so they can be unit-tested without spinning up a Session, and
 * to avoid pulling the Session module into a circular import.
 */

export interface AttachmentRefLike {
  type: string
  mime?: string
  filename?: string
  repo_path?: string
}

export const ACTIVE_IMAGE_REFS_DEFAULT_MAX = 3

function isInlineableImage(part: AttachmentRefLike): part is Required<Pick<AttachmentRefLike, "filename" | "repo_path">> & AttachmentRefLike {
  if (part.type !== "attachment_ref") return false
  if (!part.mime?.startsWith("image/")) return false
  if (!part.repo_path) return false
  if (!part.filename) return false
  return true
}

function applyFifoCap(refs: string[], max: number): string[] {
  if (max <= 0) return []
  if (refs.length <= max) return refs
  return refs.slice(refs.length - max)
}

/**
 * Compute the new activeImageRefs after a fresh user message commit.
 * Walks the message's parts, picks inline-eligible images, dedups against the
 * prior active set, and applies a FIFO cap.
 */
export function addOnUpload(
  prior: string[] | undefined,
  parts: AttachmentRefLike[],
  options: { max?: number } = {},
): string[] {
  const max = options.max ?? ACTIVE_IMAGE_REFS_DEFAULT_MAX
  const seen = new Set(prior ?? [])
  const next = [...(prior ?? [])]
  for (const part of parts) {
    if (!isInlineableImage(part)) continue
    if (seen.has(part.filename)) continue
    seen.add(part.filename)
    next.push(part.filename)
  }
  return applyFifoCap(next, max)
}

/**
 * Push a filename onto the active set in response to a `reread_attachment`
 * voucher call. The caller is responsible for verifying the filename
 * actually matches an attachment_ref in session history; this helper only
 * handles dedup + FIFO.
 */
export function addOnReread(
  prior: string[] | undefined,
  filename: string,
  options: { max?: number } = {},
): string[] {
  const max = options.max ?? ACTIVE_IMAGE_REFS_DEFAULT_MAX
  const seen = new Set(prior ?? [])
  if (seen.has(filename)) return prior ?? []
  const next = [...(prior ?? []), filename]
  return applyFifoCap(next, max)
}

/**
 * Clear the active set after an assistant turn finishes (regardless of
 * `finish` value — R9 mitigation). Returns both the cleared list (for
 * telemetry) and the empty next state.
 */
export function drainAfterAssistant(prior: string[] | undefined): {
  drained: string[]
  next: string[]
} {
  return {
    drained: [...(prior ?? [])],
    next: [],
  }
}
