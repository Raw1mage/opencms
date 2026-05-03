/**
 * Legacy OLE2 plain-text fallback for .doc / .xls / .ppt uploads.
 *
 * docxmcp is .docx-only. The 90s OLE2 binary formats need their own
 * extractor, and per the project's "no third-party dependency" rule
 * we cannot pull in olefile / xlrd / etc. This is a crude printable-
 * runs scanner that produces a usable-but-noisy body.md.
 *
 * DD-8 (layout-preserving rewrite, 2026-05-03):
 *   - Two passes: ASCII / UTF-8 single-byte; UTF-16LE (CJK + Unicode)
 *   - CR / LF / tab are STRUCTURAL — preserve them as newlines / tabs
 *     in the output, not as run terminators
 *   - Preserve runs of leading spaces (table column alignment, indent)
 *   - Do not dedup across the two passes; prefer UTF-16LE pass when
 *     its byte coverage overlaps the ASCII pass (UTF-16LE is more
 *     likely to hold body text in modern legacy .doc)
 *   - Apply a density threshold (0.0..1.0) to drop lines whose
 *     printable-character ratio is below the threshold (default 0.4)
 *   - Output writes to incoming/<stem>/body.md
 */

import path from "node:path"
import fs from "node:fs/promises"
import {
  writeManifest,
  MANIFEST_SCHEMA_VERSION,
  stemDirForStem,
  type Manifest,
  type ManifestSource,
} from "./manifest"

export interface LegacyScanInput {
  stem: string
  source: ManifestSource
  /** Raw upload bytes. */
  bytes: Uint8Array
  /** Density threshold (0..1); lines below are dropped. Default 0.4. */
  densityThreshold?: number
  /** Project root override (test injection). */
  projectRoot?: string
}

export interface LegacyScanResult {
  /** Wall time of the scan in ms. */
  durationMs: number
  /** Number of lines kept (post-density-filter) in body.md. */
  lineCount: number
  /** Number of bytes written to body.md (UTF-8). */
  byteSize: number
  /** Body.md content (also written to disk). */
  body: string
}

const DEFAULT_DENSITY_THRESHOLD = 0.4

/**
 * Run the scan and write body.md + manifest.json into incoming/<stem>/.
 */
export async function scanLegacyOle2(input: LegacyScanInput): Promise<LegacyScanResult> {
  const started = performance.now()
  const body = renderBody(input.bytes, input.densityThreshold ?? DEFAULT_DENSITY_THRESHOLD)
  const lineCount = body === "" ? 0 : body.split("\n").length
  const byteSize = Buffer.byteLength(body, "utf8")
  const durationMs = Math.round(performance.now() - started)

  const stemDir = stemDirForStem(input.stem, input.projectRoot)
  await fs.mkdir(stemDir, { recursive: true })
  await fs.writeFile(path.join(stemDir, "body.md"), body, "utf8")

  const manifest: Manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    stem: input.stem,
    source: input.source,
    decompose: {
      status: "ok",
      duration_ms: durationMs,
      decomposer: "opencode.legacy_ole2_scanner",
      background_status: "n/a",
    },
    files: [
      {
        path: "body.md",
        kind: "body",
        summary: `${lineCount} lines (noisy, structure-guessable)`,
        byte_size: byteSize,
      },
    ],
  }
  await writeManifest(stemDir, manifest)

  return { durationMs, lineCount, byteSize, body }
}

// ----------------------------------------------------------------------
// Scanner internals
// ----------------------------------------------------------------------

/**
 * Run both passes, prefer UTF-16LE on overlap, apply density filter.
 * Returns the final body.md string (may be empty).
 */
export function renderBody(bytes: Uint8Array, densityThreshold: number): string {
  const ascii = scanAsciiUtf8(bytes)
  const utf16 = scanUtf16Le(bytes)

  // Prefer UTF-16LE pass when both yielded content. Heuristic: if
  // utf16 produced more characters than ascii, treat it as the better
  // pass and use it alone. Otherwise concatenate (ascii first, utf16
  // second) so callers see both signals.
  let raw: string
  if (utf16.length > ascii.length * 1.2) {
    raw = utf16
  } else if (ascii.length > utf16.length * 1.2) {
    raw = ascii
  } else if (ascii.length === 0) {
    raw = utf16
  } else if (utf16.length === 0) {
    raw = ascii
  } else {
    // Roughly equal — concatenate with a separator so AI can see both
    raw = `${ascii}\n\n--- (UTF-16LE pass) ---\n\n${utf16}`
  }

  return applyDensityFilter(raw, densityThreshold)
}

/**
 * ASCII / UTF-8 single-byte pass. Treats:
 *   - 0x20..0x7E: printable ASCII (kept verbatim)
 *   - 0x09: tab (kept as \t)
 *   - 0x0A: newline (kept as \n)
 *   - 0x0D: CR (kept as \n; collapses CRLF to LF)
 *   - other: drop, but DON'T collapse adjacent newlines created by drops
 *
 * Multiple consecutive non-printable bytes collapse to at most one
 * newline (so we don't emit pages of blank lines when scanning OLE2
 * binary headers).
 */
function scanAsciiUtf8(bytes: Uint8Array): string {
  const out: string[] = []
  let lastWasNewline = false
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b >= 0x20 && b < 0x7f) {
      out.push(String.fromCharCode(b))
      lastWasNewline = false
    } else if (b === 0x09) {
      out.push("\t")
      lastWasNewline = false
    } else if (b === 0x0a || b === 0x0d) {
      // Treat CR / LF / CRLF as a single newline; collapse runs.
      if (!lastWasNewline) {
        out.push("\n")
        lastWasNewline = true
      }
      // CRLF: skip the LF after CR.
      if (b === 0x0d && i + 1 < bytes.length && bytes[i + 1] === 0x0a) i++
    } else {
      // Non-printable binary noise. Treat as a soft separator: insert
      // at most one newline between text runs so layout doesn't
      // flatten everything into one mega-line.
      if (!lastWasNewline) {
        out.push("\n")
        lastWasNewline = true
      }
    }
  }
  return out.join("")
}

/**
 * UTF-16LE pass. Iterates over byte pairs as little-endian 16-bit
 * codepoints. Same structural-character treatment as the ASCII pass:
 * tab / CR / LF preserved, other non-BMP-printable codepoints become
 * soft separators.
 *
 * BMP printable range used: codepoints in [0x20, 0xFFFD] excluding
 * the surrogate halves [0xD800, 0xDFFF] and U+007F. This catches
 * Latin, CJK, Hangul, Cyrillic, Hebrew, etc.
 */
function scanUtf16Le(bytes: Uint8Array): string {
  const out: string[] = []
  let lastWasNewline = false
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const cp = bytes[i] | (bytes[i + 1] << 8)
    if (cp === 0x09) {
      out.push("\t")
      lastWasNewline = false
    } else if (cp === 0x0a || cp === 0x0d) {
      if (!lastWasNewline) {
        out.push("\n")
        lastWasNewline = true
      }
    } else if (
      cp >= 0x20 &&
      cp !== 0x7f &&
      cp < 0xfffe &&
      (cp < 0xd800 || cp > 0xdfff)
    ) {
      out.push(String.fromCharCode(cp))
      lastWasNewline = false
    } else {
      if (!lastWasNewline) {
        out.push("\n")
        lastWasNewline = true
      }
    }
  }
  return out.join("")
}

/**
 * Density filter: keep a line only if (printable chars / total chars) ≥
 * threshold. Empty lines pass (they convey paragraph structure).
 *
 * "Printable" here means: any non-whitespace, non-control character.
 * Leading whitespace is preserved within kept lines.
 */
export function applyDensityFilter(text: string, threshold: number): string {
  if (threshold <= 0) return text
  const lines = text.split("\n")
  const kept: string[] = []
  for (const line of lines) {
    if (line.length === 0) {
      kept.push(line)
      continue
    }
    let printable = 0
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i)
      if (c > 0x20 && c !== 0x7f) printable++
    }
    const density = printable / line.length
    if (density >= threshold) kept.push(line)
  }
  return kept.join("\n")
}
