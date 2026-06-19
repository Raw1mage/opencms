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
  // v4 hotfix: new image uploads carry the bytes under session_path, NOT
  // repo_path (see message-v2 AttachmentRefPart). Inline-eligibility must
  // accept either — gating on repo_path alone silently rejects every modern
  // upload (the latent trap that made v5's "one-line re-enable" a no-op).
  session_path?: string
  // est_tokens of this attachment, used by the upload auto-inline budget gate.
  est_tokens?: number
}

export const ACTIVE_IMAGE_REFS_DEFAULT_MAX = 3

function isInlineableImage(part: AttachmentRefLike): part is Required<Pick<AttachmentRefLike, "filename">> & AttachmentRefLike {
  if (part.type !== "attachment_ref") return false
  if (!part.mime?.startsWith("image/")) return false
  if (!part.repo_path && !part.session_path) return false
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
 * attachment-lifecycle v8: budget-gated auto-inline on upload. Re-enables the
 * v4 "see it immediately" behavior for the common single-/small-upload case,
 * while preserving v5/DD-22's bounded-cost property for large image dumps.
 *
 * Collects the inline-eligible images freshly attached to this user message
 * that aren't already active, sums their est_tokens, and:
 *   - if the sum is within `budgetTokens` → queues them all (FIFO-capped),
 *     so the next assistant turn sees the pixels with no reread round-trip;
 *   - if the sum exceeds `budgetTokens` (a big/many-image dump) → returns the
 *     prior set unchanged, leaving those images on the opt-in inventory path.
 *
 * `budgetTokens <= 0` disables auto-inline entirely (pure v5 opt-in). The
 * all-or-nothing decision (rather than partial fill) keeps the rule legible:
 * a user either gets their small upload shown automatically, or — for a heavy
 * dump — the AI deliberately picks which images to fetch.
 */
export function addOnUploadGated(
  prior: string[] | undefined,
  parts: AttachmentRefLike[],
  options: { max?: number; budgetTokens: number },
): string[] {
  const priorSet = prior ?? []
  if (options.budgetTokens <= 0) return priorSet
  const max = options.max ?? ACTIVE_IMAGE_REFS_DEFAULT_MAX
  const seen = new Set(priorSet)
  const fresh: { filename: string; est: number }[] = []
  for (const part of parts) {
    if (!isInlineableImage(part)) continue
    if (seen.has(part.filename)) continue
    seen.add(part.filename)
    fresh.push({ filename: part.filename, est: part.est_tokens ?? 0 })
  }
  if (fresh.length === 0) return priorSet
  const total = fresh.reduce((sum, f) => sum + f.est, 0)
  if (total > options.budgetTokens) return priorSet
  return applyFifoCap([...priorSet, ...fresh.map((f) => f.filename)], max)
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

/**
 * BR issue_20260611_restart-resume-not-draining-active-image: decide whether a
 * session's activeImageRefs should be drained on its FIRST touch after a daemon
 * (re)start.
 *
 * The compaction-boundary drain (publishCompactedAndResetChain) only fires
 * in-process; a daemon restart / session resume neither replays nor triggers a
 * compaction, so a session that carried a non-empty active set across the
 * restart keeps re-inlining the stale image until it happens to compact. This
 * predicate gives the cross-process complement: true only when this process
 * hasn't seen the session yet AND it still carries a leftover active set.
 *
 * The caller owns the `seen` set (module-level, dies with the process) and must
 * mark the session seen after calling — regardless of the result — so the check
 * runs at most once per session per daemon lifecycle.
 */
export function shouldResumeDrainImages(
  seen: ReadonlySet<string>,
  sessionID: string,
  activeImageRefs: ReadonlyArray<string> | undefined,
): boolean {
  if (seen.has(sessionID)) return false
  return (activeImageRefs?.length ?? 0) > 0
}
