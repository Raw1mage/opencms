/**
 * Office mime classification for the upload-time auto-decompose hook.
 * See specs/docx-upload-autodecompose/ DD-9 + tasks.md phase 3.1.
 *
 * Classifies an upload by mime type (and as a fallback by filename
 * extension) into one of seven buckets. The hook in tryLandInIncoming
 * dispatches each bucket to a specific decomposer:
 *
 *   docx       → docxmcp.extract_all (two-phase async)
 *   doc        → in-process legacy OLE2 scanner
 *   xls        → in-process legacy OLE2 scanner
 *   ppt        → in-process legacy OLE2 scanner
 *   xlsx       → unsupported writer (no xlsx-mcp yet)
 *   pptx       → unsupported writer (no pptx-mcp yet)
 *   non-office → no-op (passes through to existing image / pdf / text path)
 */

export type OfficeKind = "docx" | "doc" | "xls" | "ppt" | "xlsx" | "pptx" | "non-office"

const MIME_TO_KIND: Record<string, OfficeKind> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint": "ppt",
}

const EXT_TO_KIND: Record<string, OfficeKind> = {
  ".docx": "docx",
  ".doc": "doc",
  ".xlsx": "xlsx",
  ".xls": "xls",
  ".pptx": "pptx",
  ".ppt": "ppt",
}

/**
 * Classify by mime first; fall back to filename extension if the mime
 * is generic (e.g. "application/octet-stream" sometimes leaks through).
 * Returns "non-office" when neither mime nor extension matches a known
 * Office format.
 */
export function classifyOffice(mime: string | undefined, filename: string | undefined): OfficeKind {
  if (mime && MIME_TO_KIND[mime]) return MIME_TO_KIND[mime]
  if (filename) {
    const idx = filename.lastIndexOf(".")
    if (idx > 0) {
      const ext = filename.slice(idx).toLowerCase()
      if (EXT_TO_KIND[ext]) return EXT_TO_KIND[ext]
    }
  }
  return "non-office"
}

/**
 * Coarse subset queries used by the hook to pick a code path:
 *   isModernOffice  → routes to docxmcp (docx) or unsupported writer (xlsx, pptx)
 *   isLegacyOle2    → routes to legacy in-process scanner (doc, xls, ppt)
 *   isAnyOffice     → triggers the hook at all
 */
export function isModernOffice(kind: OfficeKind): boolean {
  return kind === "docx" || kind === "xlsx" || kind === "pptx"
}

export function isLegacyOle2(kind: OfficeKind): boolean {
  return kind === "doc" || kind === "xls" || kind === "ppt"
}

export function isAnyOffice(kind: OfficeKind): boolean {
  return kind !== "non-office"
}

/**
 * Decomposer routing per DD-9. Each kind maps to exactly one
 * decomposer name (matches manifest.decompose.decomposer enum):
 *
 *   docx → docxmcp.extract_all
 *   doc / xls / ppt → opencode.legacy_ole2_scanner
 *   xlsx / pptx → opencode.unsupported_writer
 *
 * docxmcp tool-group-consolidation Phase 1b note (2026-05-23):
 * the label "docxmcp.extract_all" is now stale at the runtime level —
 * decompose-hook.ts calls docxmcp_document(action=decompose) via the
 * facade, not docxmcp_extract_all directly. The label survives as an
 * opencode-internal telemetry / manifest tag; it is NOT part of any
 * cross-repo contract (docxmcp never sees this value). A rename to
 * "docxmcp.document.decompose" is deferred — it would touch manifest
 * cache compatibility + 3 test files; not worth the churn for a tag
 * that callers do not interpret semantically.
 */
export type DecomposerName =
  | "docxmcp.extract_all"
  | "opencode.legacy_ole2_scanner"
  | "opencode.unsupported_writer"
  | "opencode.failure_recorder"

export function decomposerForKind(kind: OfficeKind): DecomposerName | null {
  if (kind === "docx") return "docxmcp.extract_all"
  if (isLegacyOle2(kind)) return "opencode.legacy_ole2_scanner"
  if (kind === "xlsx" || kind === "pptx") return "opencode.unsupported_writer"
  return null
}
