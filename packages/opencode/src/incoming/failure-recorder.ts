/**
 * Failure recorder + unsupported writer for the upload-time
 * auto-decompose hook. Both produce a manifest.json plus a single
 * human-readable .md file inside incoming/<stem>/ so the routing
 * hint generator and the AI both see the same uniform shape
 * regardless of outcome.
 *
 * No silent failures (AGENTS.md rule 1): every failure path here
 * surfaces concretely in the manifest's `decompose.reason`.
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

export interface RecordFailureInput {
  /** Stem name (no extension), e.g. "foo" for foo.docx. */
  stem: string
  /** Origin source metadata for the upload that failed. */
  source: ManifestSource
  /** One-sentence plain-language reason. No stack trace, no file paths. */
  reason: string
  /** Wall time of the fast phase up to the failure (ms). */
  durationMs: number
  /** Project root override (test injection). */
  projectRoot?: string
}

/**
 * Write incoming/<stem>/failure.md + incoming/<stem>/manifest.json
 * with `status: failed`. Used by the dispatch hook when:
 *   - extract_all timed out
 *   - extract_all returned a protocol-level error
 *   - the legacy OLE2 scanner threw
 *   - any other fast-phase exception
 *
 * After writing, the routing hint generator picks up the failure
 * manifest and renders the DD-6 wording for the AI.
 */
export async function recordFailure(input: RecordFailureInput): Promise<void> {
  const stemDir = stemDirForStem(input.stem, input.projectRoot)
  await fs.mkdir(stemDir, { recursive: true })

  const failureMd = `# 自動拆解失敗\n\n${input.reason}\n`
  await fs.writeFile(path.join(stemDir, "failure.md"), failureMd, "utf8")

  const manifest: Manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    stem: input.stem,
    source: input.source,
    decompose: {
      status: "failed",
      duration_ms: input.durationMs,
      reason: input.reason,
      decomposer: "opencode.failure_recorder",
      background_status: "n/a",
    },
    files: [
      {
        path: "failure.md",
        kind: "failure",
        summary: input.reason.slice(0, 80),
        byte_size: Buffer.byteLength(failureMd, "utf8"),
      },
    ],
  }
  await writeManifest(stemDir, manifest)
}

export interface RecordUnsupportedInput {
  /** Stem name (no extension). */
  stem: string
  /** Origin source metadata for the upload. */
  source: ManifestSource
  /** Format label for the user-facing message, e.g. "xlsx" or "pptx". */
  formatLabel: string
  /** Project root override (test injection). */
  projectRoot?: string
}

/**
 * Write incoming/<stem>/unsupported.md + manifest.json with
 * `status: unsupported`. Used by the dispatch hook for xlsx / pptx
 * uploads (no decomposer for those formats yet).
 */
export async function recordUnsupported(input: RecordUnsupportedInput): Promise<void> {
  const stemDir = stemDirForStem(input.stem, input.projectRoot)
  await fs.mkdir(stemDir, { recursive: true })

  const reason = `此格式（${input.formatLabel}）目前不支援自動拆解；請使用者轉成 .docx 後再上傳`
  const unsupportedMd = `# 此格式不支援自動拆解\n\n${reason}\n`
  await fs.writeFile(path.join(stemDir, "unsupported.md"), unsupportedMd, "utf8")

  const manifest: Manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    stem: input.stem,
    source: input.source,
    decompose: {
      status: "unsupported",
      duration_ms: 0,
      reason,
      decomposer: "opencode.unsupported_writer",
      background_status: "n/a",
    },
    files: [
      {
        path: "unsupported.md",
        kind: "unsupported",
        summary: reason.slice(0, 80),
        byte_size: Buffer.byteLength(unsupportedMd, "utf8"),
      },
    ],
  }
  await writeManifest(stemDir, manifest)
}
