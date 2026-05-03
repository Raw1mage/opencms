import path from "node:path"
import fs from "node:fs"
import { promises as fsp } from "node:fs"

import { Global } from "@/global"

import { IncomingPaths } from "./paths"

/**
 * Session-scoped attachment storage (attachment-lifecycle v4 hotfix).
 *
 * Image attachments do not belong in the project repo — they are usually
 * debug/screenshot uploads with no relationship to the codebase. Storing
 * them under `<repo>/incoming/` pollutes the working tree and forces the
 * user to manage them via .gitignore / git clean.
 *
 * Image binary lives at:
 *   `${Global.Path.data}/sessions/<sessionID>/attachments/<filename>`
 *
 * which translates to `~/.local/share/opencode/sessions/<id>/attachments/`
 * under default XDG layout.
 *
 * Office documents (docx / xlsx / pptx) and PDFs continue to use the
 * `<repo>/incoming/` path because those are project knowledge content
 * meant to be diffable / versioned alongside code. See
 * /specs/repo-incoming-attachments + /specs/docx-upload-autodecompose.
 */
export namespace SessionIncomingPaths {
  export const SESSIONS_DIR = "sessions"
  export const ATTACHMENTS_DIR = "attachments"

  function sessionRoot(sessionID: string): string {
    return path.join(Global.Path.data, SESSIONS_DIR, sessionID)
  }

  export function attachmentsDir(sessionID: string): string {
    return path.join(sessionRoot(sessionID), ATTACHMENTS_DIR)
  }

  export function attachmentPath(sessionID: string, filename: string): string {
    return path.join(attachmentsDir(sessionID), filename)
  }

  /**
   * Resolve an absolute filesystem path from a `session_path` value
   * carried on an attachment_ref part. Caller passes the raw stored
   * value (e.g. "sessions/<id>/attachments/<filename>" or just the
   * relative tail) and the sessionID so we can validate the path stays
   * scoped to that session's folder.
   */
  export function resolveAbsolute(sessionID: string, sessionPath: string): string {
    const trimmed = sessionPath.replace(/^[/]+/, "")
    const dataRoot = Global.Path.data
    const candidate = path.resolve(dataRoot, trimmed)
    const expectedRoot = path.resolve(sessionRoot(sessionID))
    if (!candidate.startsWith(expectedRoot + path.sep) && candidate !== expectedRoot) {
      throw new Error(
        `session_path resolves outside session root (sessionID=${sessionID}, path=${sessionPath})`,
      )
    }
    return candidate
  }

  /**
   * Sanitize, dedupe, conflict-rename, and atomic-write image bytes to
   * the session-scoped attachments folder. Returns the relative
   * `session_path` (rooted at Global.Path.data so the reader can
   * resolve via `resolveAbsolute(sessionID, returned)`) plus the
   * sanitized filename.
   */
  export async function tryLandInSession(input: {
    sessionID: string
    filename: string | undefined
    bytes: Uint8Array
  }): Promise<{ sessionPath: string; sha256: string; sanitizedName: string } | null> {
    if (!input.filename) return null
    let sanitized: string
    try {
      sanitized = IncomingPaths.sanitize(input.filename)
    } catch {
      return null
    }

    const dir = attachmentsDir(input.sessionID)
    await fsp.mkdir(dir, { recursive: true })

    const { createHash } = await import("node:crypto")
    const sha256 = createHash("sha256").update(input.bytes).digest("hex")

    let targetName = sanitized
    let targetPath = path.join(dir, targetName)

    if (fs.existsSync(targetPath)) {
      const existing = await fsp.readFile(targetPath).catch(() => undefined)
      if (existing) {
        const existingSha = createHash("sha256").update(existing).digest("hex")
        if (existingSha === sha256) {
          // Identical bytes — dedupe to existing file.
          return {
            sessionPath: relativeFromDataRoot(input.sessionID, targetName),
            sha256,
            sanitizedName: targetName,
          }
        }
      }
      targetName = IncomingPaths.nextConflictName(dir, sanitized)
      targetPath = path.join(dir, targetName)
    }

    const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await fsp.writeFile(tmpPath, input.bytes)
    await fsp.rename(tmpPath, targetPath)

    return {
      sessionPath: relativeFromDataRoot(input.sessionID, targetName),
      sha256,
      sanitizedName: targetName,
    }
  }

  function relativeFromDataRoot(sessionID: string, filename: string): string {
    return path.join(SESSIONS_DIR, sessionID, ATTACHMENTS_DIR, filename)
  }
}
