/**
 * Paired version-rename helper for DD-5 (amended 2026-05-03).
 *
 * When the same Office filename is uploaded twice with different
 * content, the OLD version (both source file AND bundle dir) is
 * renamed aside with a `-<old-uploaded-at>` suffix BEFORE the new
 * bytes land at the canonical position. Multi-version history then
 * accumulates as siblings that sort chronologically.
 *
 * Pairing is critical: renaming only one of the two leaves the
 * manifest's `source.filename` out of sync with the on-disk pair.
 * This helper renames both atomically (or rolls back both).
 *
 * Suffix collisions (an `incoming/<stem>-<ts>.<ext>` already exists
 * from a previous regen at the same uploaded_at second — extremely
 * rare but possible if two regens land within the same second) get
 * disambiguated with `-1`, `-2`, ... applied to BOTH file and dir
 * to keep the pair aligned.
 */

import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { Log } from "../util/log"

const log = Log.create({ service: "incoming.version-rename" })

export interface VersionRenameInput {
  /** Absolute path to the incoming/ root (= <projectRoot>/incoming). */
  incomingDirAbs: string
  /** Filename stem (no extension), e.g. "foo". */
  stem: string
  /** Filename extension WITH the leading dot, e.g. ".docx". */
  ext: string
  /** Old manifest's `source.uploaded_at` ISO string, e.g. "2026-05-03T08:14:22Z". */
  oldUploadedAtIso: string
}

export interface VersionRenameResult {
  /** Final suffix applied to BOTH file and dir (timestamp + optional disambiguator). */
  appliedSuffix: string
  /** Absolute path the OLD source file was renamed to. */
  renamedSourcePath: string
  /** Absolute path the OLD bundle dir was renamed to. */
  renamedDirPath: string
}

export class VersionRenameError extends Error {
  constructor(
    message: string,
    public override readonly cause: unknown,
    public readonly rolledBack: boolean,
  ) {
    super(message)
    this.name = "VersionRenameError"
  }
}

/**
 * Convert an ISO 8601 string ("2026-05-03T08:14:22Z" or with milliseconds /
 * offset) into the suffix format "YYYYMMDD-HHMMSS" in UTC.
 *
 * Falls back to a synthesised suffix from `Date.parse` if the input is
 * non-ISO; if that also fails, throws.
 */
export function isoToSuffix(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) {
    throw new VersionRenameError(`unparseable ISO timestamp: ${iso}`, null, false)
  }
  const d = new Date(ms)
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0")
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0")
  const dd = d.getUTCDate().toString().padStart(2, "0")
  const hh = d.getUTCHours().toString().padStart(2, "0")
  const mi = d.getUTCMinutes().toString().padStart(2, "0")
  const ss = d.getUTCSeconds().toString().padStart(2, "0")
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

/**
 * Apply the paired rename. Both source file and bundle dir get the
 * same suffix. Atomic semantics:
 *
 *   1. Pick a free suffix (timestamp; disambiguate with -1, -2, ... if needed)
 *   2. Rename the source file
 *   3. Rename the bundle dir
 *   4. If step 3 fails: undo step 2; throw with rolledBack=true
 *
 * If the source file or bundle dir is missing, that side is silently
 * skipped (it's still a "rename" success — there's nothing to rename
 * for that side). At least one of them must exist for the call to
 * make any change; if both are missing the function is a no-op.
 */
export async function pairedVersionRename(input: VersionRenameInput): Promise<VersionRenameResult> {
  const baseSuffix = isoToSuffix(input.oldUploadedAtIso)
  const sourcePath = path.join(input.incomingDirAbs, `${input.stem}${input.ext}`)
  const dirPath = path.join(input.incomingDirAbs, input.stem)

  const sourceExists = existsSync(sourcePath)
  const dirExists = existsSync(dirPath)

  if (!sourceExists && !dirExists) {
    // Nothing to rename. Still return a sensible result for callers
    // that want to record what suffix WOULD have been used.
    return {
      appliedSuffix: baseSuffix,
      renamedSourcePath: path.join(input.incomingDirAbs, `${input.stem}-${baseSuffix}${input.ext}`),
      renamedDirPath: path.join(input.incomingDirAbs, `${input.stem}-${baseSuffix}`),
    }
  }

  const appliedSuffix = pickFreeSuffix(input.incomingDirAbs, input.stem, input.ext, baseSuffix)
  const renamedSourcePath = path.join(input.incomingDirAbs, `${input.stem}-${appliedSuffix}${input.ext}`)
  const renamedDirPath = path.join(input.incomingDirAbs, `${input.stem}-${appliedSuffix}`)

  let sourceRenamed = false
  if (sourceExists) {
    try {
      await fs.rename(sourcePath, renamedSourcePath)
      sourceRenamed = true
    } catch (err) {
      log.error("source rename failed", { from: sourcePath, to: renamedSourcePath, error: String(err) })
      throw new VersionRenameError(
        `source rename ${sourcePath} → ${renamedSourcePath} failed`,
        err,
        false,
      )
    }
  }

  if (dirExists) {
    try {
      await fs.rename(dirPath, renamedDirPath)
    } catch (err) {
      log.error("dir rename failed; rolling back source rename", {
        from: dirPath,
        to: renamedDirPath,
        sourceRolledBack: sourceRenamed,
        error: String(err),
      })
      // Roll back the source rename so we don't leave a half-state.
      let rolledBack = true
      if (sourceRenamed) {
        try {
          await fs.rename(renamedSourcePath, sourcePath)
        } catch (rollbackErr) {
          log.error("source rename rollback ALSO failed; manual cleanup needed", {
            stuckAt: renamedSourcePath,
            shouldBeAt: sourcePath,
            error: String(rollbackErr),
          })
          rolledBack = false
        }
      }
      throw new VersionRenameError(
        `dir rename ${dirPath} → ${renamedDirPath} failed`,
        err,
        rolledBack,
      )
    }
  }

  return { appliedSuffix, renamedSourcePath, renamedDirPath }
}

/**
 * Find the lowest-numbered suffix (base, base-1, base-2, ...) for which
 * NEITHER the suffixed source nor the suffixed dir already exists.
 * Same suffix on both, always — keeps the pair aligned.
 */
function pickFreeSuffix(incomingDirAbs: string, stem: string, ext: string, baseSuffix: string): string {
  const candidate = (suffix: string) =>
    !existsSync(path.join(incomingDirAbs, `${stem}-${suffix}${ext}`)) &&
    !existsSync(path.join(incomingDirAbs, `${stem}-${suffix}`))

  if (candidate(baseSuffix)) return baseSuffix

  for (let n = 1; n < 100; n++) {
    const suffix = `${baseSuffix}-${n}`
    if (candidate(suffix)) return suffix
  }
  throw new VersionRenameError(
    `pickFreeSuffix exhausted disambiguator range for stem=${stem} base=${baseSuffix}`,
    null,
    false,
  )
}
