/**
 * Manifest read / write / cache-lookup helpers for the upload-time
 * auto-decompose pipeline. The manifest schema is the canonical
 * cross-repo contract — see specs/docx-upload-autodecompose/
 * data-schema.json. docxmcp WRITES it (inside extract_all); opencode
 * READS it via this module. The opencode-side helpers also write the
 * manifest in two narrow cases the docxmcp side does not handle:
 * legacy OLE2 fallback and xlsx/pptx unsupported notes.
 *
 * DD-3, DD-12, DD-13, DD-14.
 */

import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { IncomingPaths } from "./paths"
import { Log } from "../util/log"

const log = Log.create({ service: "incoming.manifest" })

export const MANIFEST_FILENAME = "manifest.json"
export const MANIFEST_SCHEMA_VERSION = 1

/** Functional kind of a single file under incoming/<stem>/. */
export type FileKind =
  | "body"
  | "outline"
  | "chapter"
  | "table"
  | "media"
  | "template"
  | "unsupported"
  | "failure"
  | "pending_marker"

/** Verdict of the fast phase. See data-schema.json. */
export type DecomposeStatus = "ok" | "failed" | "unsupported"

/**
 * Background-phase status. "n/a" means this manifest was produced by
 * a decomposer with no background phase (legacy scanner, unsupported
 * writer, failure recorder).
 */
export type BackgroundStatus = "running" | "done" | "failed" | "n/a"

/** Identifies which component produced the manifest. */
export type DecomposerName =
  | "docxmcp.extract_all"
  | "opencode.legacy_ole2_scanner"
  | "opencode.unsupported_writer"
  | "opencode.failure_recorder"

export interface ManifestSource {
  filename: string
  mime: string
  byte_size: number
  sha256: string
  uploaded_at: string // ISO 8601 UTC
}

export interface ManifestDecompose {
  status: DecomposeStatus
  duration_ms: number
  reason?: string
  decomposer?: DecomposerName
  background_status: BackgroundStatus
  pending_kinds?: Array<"body" | "chapter" | "table" | "media">
  background_duration_ms?: number
  background_error?: string
}

export interface ManifestFile {
  path: string
  kind: FileKind
  summary: string
  byte_size?: number
}

export interface Manifest {
  schema_version: 1
  stem: string
  source: ManifestSource
  decompose: ManifestDecompose
  files: ManifestFile[]
}

/** Resolve the stem dir absolute path from a stem name. */
export function stemDirForStem(stem: string, root: string = IncomingPaths.projectRoot()): string {
  return path.join(IncomingPaths.incomingDir(root), stem)
}

/** Resolve the manifest absolute path from a stem name. */
export function manifestPathForStem(stem: string, root: string = IncomingPaths.projectRoot()): string {
  return path.join(stemDirForStem(stem, root), MANIFEST_FILENAME)
}

/** Manifest path when caller already has the stem dir absolute path. */
export function manifestPathInDir(stemDirAbs: string): string {
  return path.join(stemDirAbs, MANIFEST_FILENAME)
}

/**
 * Read manifest.json from the stem dir. Returns null if missing or
 * unparseable. Validation errors log a warning and return null
 * (treat as "no manifest" for cache-lookup purposes).
 */
export async function readManifest(stemDirAbs: string): Promise<Manifest | null> {
  const manifestPath = manifestPathInDir(stemDirAbs)
  if (!existsSync(manifestPath)) return null
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, "utf8")
  } catch (err) {
    log.warn("readManifest: read failed", {
      manifestPath,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.warn("readManifest: invalid JSON", {
      manifestPath,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  const issues = validateManifest(parsed)
  if (issues.length > 0) {
    log.warn("readManifest: schema violations", { manifestPath, issues })
    return null
  }
  return parsed as Manifest
}

/**
 * Atomic-rename write of manifest.json into the stem dir. Creates the
 * stem dir if missing.
 */
export async function writeManifest(stemDirAbs: string, manifest: Manifest): Promise<void> {
  await fs.mkdir(stemDirAbs, { recursive: true })
  const finalPath = manifestPathInDir(stemDirAbs)
  const tmpPath = `${finalPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf8")
  await fs.rename(tmpPath, finalPath)
}

/**
 * Lightweight schema validation. Mirrors data-schema.json — full JSON
 * Schema validation would be heavier; for our use we only need to
 * confirm the fields we will touch are well-typed.
 */
export function validateManifest(value: unknown): string[] {
  const issues: string[] = []
  const v = value as Record<string, unknown>
  if (!v || typeof v !== "object") return ["not an object"]
  if (v.schema_version !== MANIFEST_SCHEMA_VERSION)
    issues.push(`schema_version must be ${MANIFEST_SCHEMA_VERSION}`)
  if (typeof v.stem !== "string" || v.stem.length === 0) issues.push("stem must be non-empty string")
  const src = v.source as Record<string, unknown> | undefined
  if (!src || typeof src !== "object") issues.push("source missing or not object")
  else {
    if (typeof src.filename !== "string") issues.push("source.filename missing")
    if (typeof src.mime !== "string") issues.push("source.mime missing")
    if (typeof src.byte_size !== "number") issues.push("source.byte_size missing")
    if (typeof src.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(src.sha256 as string))
      issues.push("source.sha256 must be 64-hex")
    if (typeof src.uploaded_at !== "string") issues.push("source.uploaded_at missing")
  }
  const dec = v.decompose as Record<string, unknown> | undefined
  if (!dec || typeof dec !== "object") issues.push("decompose missing or not object")
  else {
    const validStatus = dec.status === "ok" || dec.status === "failed" || dec.status === "unsupported"
    if (!validStatus) issues.push("decompose.status must be ok|failed|unsupported")
    if (typeof dec.duration_ms !== "number") issues.push("decompose.duration_ms must be number")
    const validBg =
      dec.background_status === "running" ||
      dec.background_status === "done" ||
      dec.background_status === "failed" ||
      dec.background_status === "n/a"
    if (!validBg) issues.push("decompose.background_status must be running|done|failed|n/a")
    if ((dec.status === "failed" || dec.status === "unsupported") && typeof dec.reason !== "string")
      issues.push("decompose.reason required when status != ok")
    if (dec.background_status === "running" && !Array.isArray(dec.pending_kinds))
      issues.push("decompose.pending_kinds required when background_status == running")
    if (dec.background_status === "failed" && typeof dec.background_error !== "string")
      issues.push("decompose.background_error required when background_status == failed")
  }
  if (!Array.isArray(v.files)) issues.push("files must be array")
  return issues
}

// ----------------------------------------------------------------------
// Cache lookup (DD-5 + DD-12 + DD-14)
// ----------------------------------------------------------------------

/**
 * Cache verdict returned by lookupCache.
 *
 *   hit          — prior manifest matches (sha + filename); reuse it
 *                   directly. Includes failed and unsupported manifests
 *                   per DD-12.
 *   fresh        — no prior pair on disk; decompose into a brand-new
 *                   incoming/<stem>/.
 *   regen        — prior pair exists but its sha differs from the new
 *                   upload OR the prior background is stale. Caller must
 *                   run the paired version-rename helper before
 *                   decomposing.
 */
export type CacheVerdict = "hit" | "fresh" | "regen"

export interface CacheLookupResult {
  verdict: CacheVerdict
  /** Present when verdict is "hit"; the manifest to reuse. */
  cached?: Manifest
  /**
   * Present when verdict is "regen"; the OLD manifest's source.uploaded_at
   * — needed by the version-rename helper to compute the suffix.
   */
  priorUploadedAt?: string
  /**
   * Present when verdict is "regen" and the trigger was a stale running
   * background (DD-14 G6/G8). The caller may want to surface this in
   * telemetry or routing-hint diagnostics.
   */
  staleRunning?: boolean
}

export interface CacheLookupInput {
  /** Absolute path to the prior incoming/<stem>/ dir, or where it would be. */
  stemDirAbs: string
  /** sha256 of the new upload's bytes (lowercase hex). */
  newSha256: string
  /** Final on-disk filename of the new upload (after sanitisation). */
  newFilename: string
  /** Now timestamp (ms since epoch); injectable for tests. Defaults to Date.now(). */
  now?: number
  /** Stale-running cutoff (ms). Default 600_000 (DD-14 MAX_BACKGROUND_AGE). */
  maxBackgroundAgeMs?: number
}

const DEFAULT_MAX_BACKGROUND_AGE_MS = 600_000

/**
 * Decide whether to reuse, freshly decompose, or regen-with-rename.
 * Implements DD-5 + DD-12 + DD-14 G6/G8.
 *
 * Cache hit semantics include both successful AND failed manifests
 * (per DD-12: "失敗也入 cache"). Stale running detection: if the
 * prior manifest is in `running` and older than `maxBackgroundAgeMs`,
 * treat as regen so the prior partial state gets renamed aside and a
 * fresh decompose runs.
 */
export async function lookupCache(input: CacheLookupInput): Promise<CacheLookupResult> {
  const prior = await readManifest(input.stemDirAbs)
  if (!prior) return { verdict: "fresh" }

  const sameSha = prior.source.sha256.toLowerCase() === input.newSha256.toLowerCase()
  const sameName = prior.source.filename === input.newFilename

  if (sameSha && sameName) {
    // Stale-running detection (DD-14 G6/G8): a prior `running` state
    // older than the cutoff is treated as abandoned. Force regen so the
    // dead partial state is preserved as a sibling and a fresh attempt
    // starts.
    if (prior.decompose.background_status === "running") {
      const now = input.now ?? Date.now()
      const maxAge = input.maxBackgroundAgeMs ?? DEFAULT_MAX_BACKGROUND_AGE_MS
      const uploadedAtMs = Date.parse(prior.source.uploaded_at)
      if (Number.isFinite(uploadedAtMs) && now - uploadedAtMs > maxAge) {
        return {
          verdict: "regen",
          priorUploadedAt: prior.source.uploaded_at,
          staleRunning: true,
        }
      }
    }
    return { verdict: "hit", cached: prior }
  }

  return {
    verdict: "regen",
    priorUploadedAt: prior.source.uploaded_at,
  }
}
