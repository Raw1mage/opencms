/**
 * Upload-time auto-decompose hook for Office attachments.
 *
 * Called from session/user-message-parts.ts → tryLandInIncoming
 * whenever the upload's mime / extension classifies as Office. The
 * hook subsumes the existing write/dedupe/conflict-rename logic for
 * Office mimes (per DD-9 + DD-5 rewrites): it owns cache lookup,
 * paired version-rename on sha drift, atomic write of new bytes, and
 * the synchronous fast-phase decompose call.
 *
 * Non-Office uploads still use tryLandInIncoming's original flow.
 *
 * SPEC: specs/docx-upload-autodecompose/
 *   DD-1  two-phase fast + background
 *   DD-5  paired version-rename of OLD pair on sha drift
 *   DD-9  hook lives here, not in incoming/dispatcher.ts
 *   DD-12 failed manifests count as cache hits
 *   DD-13 routing hint instructs AI to re-read manifest
 *   DD-14 stale-running detection, timeout knobs, configurability
 */

import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Log } from "../util/log"
import { Bus } from "@/bus"
import { BusEvent } from "../bus/bus-event"
import z from "zod"
import { IncomingPaths } from "./paths"
import { IncomingDispatcher } from "./dispatcher"
import { IncomingHistory } from "./history"
import { MCP } from "../mcp"
import {
  classifyOffice,
  decomposerForKind,
  isLegacyOle2,
  type OfficeKind,
} from "./office-mime"
import {
  lookupCache,
  readManifest,
  stemDirForStem,
  type Manifest,
  type ManifestSource,
} from "./manifest"
import { pairedVersionRename, VersionRenameError } from "./version-rename"
import { recordFailure, recordUnsupported } from "./failure-recorder"
import { scanLegacyOle2 } from "./legacy-ole2-scanner"
import { startPollLoop } from "./poll-loop"

const log = Log.create({ service: "incoming.decompose-hook" })

// ── Telemetry events ───────────────────────────────────────────────────

export const DecomposeOutcome = BusEvent.define(
  "incoming.decompose",
  z.object({
    mime: z.string(),
    format: z.enum(["docx", "doc", "xls", "ppt", "xlsx", "pptx"]),
    byteSize: z.number(),
    durationMs: z.number(),
    cache: z.enum(["hit", "miss"]),
    cacheOutcome: z.enum(["hit", "fresh", "regen"]),
    status: z.enum(["ok", "failed", "unsupported"]),
    reason: z.string().optional(),
    decomposer: z.string().optional(),
    stem: z.string(),
    priorSibling: z.string().optional(),
  }),
)

// ── Tunables (DD-14) ───────────────────────────────────────────────────
//
// These are the "static defaults" baked in at build time. Per DD-14
// every magic number is also exposed via tweaks.cfg; the tweaks
// integration lives in phase 9 — for now the static defaults are
// authoritative.

export const FAST_PHASE_TIMEOUT_MS = 30_000
export const MAX_BACKGROUND_AGE_MS = 600_000
export const DOCXMCP_APP_ID = "docxmcp"
export const DOCXMCP_TOOL_EXTRACT_ALL = "extract_all"

// ── Public types ───────────────────────────────────────────────────────

export type LandOfficeOutcome = "hit" | "fresh" | "regen" | "failed" | "unsupported"

export interface LandOfficeInput {
  /** Sanitized filename (already passed through IncomingPaths.sanitize). */
  filename: string
  mime: string
  bytes: Uint8Array
  sha256: string
  /** Repo project root absolute path. */
  projectRoot: string
  /** Originating session id (for history journal). */
  sessionID: string | null
  /** Now timestamp (injectable for tests). */
  now?: Date
}

export interface LandOfficeResult {
  outcome: LandOfficeOutcome
  /** repo-relative path to the source file (e.g. "incoming/foo.docx"). */
  repoPath: string
  /** Final sanitized filename actually used (matches input.filename for Office — no (N) suffix path). */
  sanitizedName: string
  /** repo-relative path to the bundle dir (e.g. "incoming/foo"). */
  bundleRepoPath: string
  /** Most-recent manifest after this call. May be the cached one on hit. */
  manifest: Manifest | null
  /** When outcome == "regen", the suffix applied to the OLD pair. */
  appliedRenameSuffix?: string
}

/**
 * Top-level entry. Idempotent within the constraints of DD-12 (failed
 * manifests are sticky until manually cleaned).
 */
export async function landOfficeUpload(input: LandOfficeInput): Promise<LandOfficeResult> {
  const kind = classifyOffice(input.mime, input.filename)
  if (kind === "non-office") {
    throw new Error(
      `landOfficeUpload called for non-office mime ${input.mime} (filename ${input.filename}); caller must route non-office uploads through the legacy tryLandInIncoming path`,
    )
  }
  const startedAt = performance.now()
  const now = input.now ?? new Date()
  const stem = IncomingPaths.stem(input.filename)
  const ext = path.extname(input.filename).toLowerCase()
  const incomingDir = IncomingPaths.incomingDir(input.projectRoot)
  const stemDir = stemDirForStem(stem, input.projectRoot)
  await fs.mkdir(incomingDir, { recursive: true })

  // ── 1. Cache lookup ────────────────────────────────────────────────
  const verdict = await lookupCache({
    stemDirAbs: stemDir,
    newSha256: input.sha256,
    newFilename: input.filename,
    now: now.getTime(),
    maxBackgroundAgeMs: MAX_BACKGROUND_AGE_MS,
  })

  // ── 2. Cache HIT — short-circuit ───────────────────────────────────
  if (verdict.verdict === "hit") {
    const repoPath = path.join(IncomingPaths.INCOMING_DIR, input.filename)
    const result: LandOfficeResult = {
      outcome: "hit",
      repoPath,
      sanitizedName: input.filename,
      bundleRepoPath: path.join(IncomingPaths.INCOMING_DIR, stem),
      manifest: verdict.cached!,
    }
    await emitTelemetry({
      input,
      stem,
      kind,
      cache: "hit",
      cacheOutcome: "hit",
      status: verdict.cached!.decompose.status,
      reason: verdict.cached!.decompose.reason,
      decomposer: verdict.cached!.decompose.decomposer,
      durationMs: Math.round(performance.now() - startedAt),
    })
    log.info("cache hit", { stem, status: verdict.cached!.decompose.status })
    return result
  }

  // ── 3. Cache REGEN — paired version-rename of OLD pair ─────────────
  let appliedRenameSuffix: string | undefined
  if (verdict.verdict === "regen" && verdict.priorUploadedAt) {
    try {
      const renamed = await pairedVersionRename({
        incomingDirAbs: incomingDir,
        stem,
        ext,
        oldUploadedAtIso: verdict.priorUploadedAt,
      })
      appliedRenameSuffix = renamed.appliedSuffix
      log.info("paired version-rename applied", {
        stem,
        suffix: renamed.appliedSuffix,
        staleRunning: !!verdict.staleRunning,
      })
    } catch (err) {
      const reason =
        err instanceof VersionRenameError
          ? `舊版本歸檔失敗 (rolledBack=${err.rolledBack})：${err.message}`
          : `舊版本歸檔錯誤：${err instanceof Error ? err.message : String(err)}`
      // Reject the new upload (DD-5: both succeed or both rollback;
      // partial state should not happen but if it does, surface).
      throw new Error(reason)
    }
  }

  // ── 4. Atomic write of NEW bytes to canonical position ─────────────
  const targetPath = path.join(incomingDir, input.filename)
  const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await fs.writeFile(tmpPath, input.bytes)
  await fs.rename(tmpPath, targetPath)

  // ── 5. History journal entry for the source file write ─────────────
  await IncomingHistory.appendEntry(
    input.filename,
    IncomingHistory.makeEntry({
      source: "upload",
      sha256: input.sha256,
      sizeBytes: input.bytes.byteLength,
      mtime: Math.floor(Date.now()),
      sessionId: input.sessionID,
    }),
    { root: input.projectRoot, emitBus: true },
  ).catch((err) => {
    log.warn("history append failed (non-fatal)", {
      filename: input.filename,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  // ── 6. Build the canonical manifest source block (used by all paths) ─
  const manifestSource: ManifestSource = {
    filename: input.filename,
    mime: input.mime,
    byte_size: input.bytes.byteLength,
    sha256: input.sha256,
    uploaded_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  }

  const repoPath = path.join(IncomingPaths.INCOMING_DIR, input.filename)
  const bundleRepoPath = path.join(IncomingPaths.INCOMING_DIR, stem)
  const cacheOutcome: "fresh" | "regen" = verdict.verdict === "regen" ? "regen" : "fresh"
  const cache: "hit" | "miss" = "miss"

  // ── 7. Dispatch by Office kind ─────────────────────────────────────
  const decomposerName = decomposerForKind(kind)
  log.info("dispatching", { stem, kind, decomposer: decomposerName, cacheOutcome })

  // 7a. xlsx / pptx → unsupported writer (no decomposer registered)
  if (kind === "xlsx" || kind === "pptx") {
    try {
      await recordUnsupported({
        stem,
        source: manifestSource,
        formatLabel: kind,
        projectRoot: input.projectRoot,
      })
      const manifest = await readManifest(stemDir)
      await emitTelemetry({
        input,
        stem,
        kind,
        cache,
        cacheOutcome,
        status: "unsupported",
        decomposer: "opencode.unsupported_writer",
        durationMs: Math.round(performance.now() - startedAt),
        priorSibling: appliedRenameSuffix ? `${stem}-${appliedRenameSuffix}` : undefined,
      })
      return {
        outcome: "unsupported",
        repoPath,
        sanitizedName: input.filename,
        bundleRepoPath,
        manifest,
        appliedRenameSuffix,
      }
    } catch (err) {
      return await recordHookFailure({
        input,
        stem,
        kind,
        manifestSource,
        repoPath,
        bundleRepoPath,
        cache,
        cacheOutcome,
        appliedRenameSuffix,
        startedAt,
        reason: `不支援格式寫入失敗：${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  // 7b. Legacy OLE2 (.doc / .xls / .ppt) → in-process scanner
  if (isLegacyOle2(kind)) {
    try {
      await scanLegacyOle2({
        stem,
        source: manifestSource,
        bytes: input.bytes,
        projectRoot: input.projectRoot,
      })
      const manifest = await readManifest(stemDir)
      await emitTelemetry({
        input,
        stem,
        kind,
        cache,
        cacheOutcome,
        status: "ok",
        decomposer: "opencode.legacy_ole2_scanner",
        durationMs: Math.round(performance.now() - startedAt),
        priorSibling: appliedRenameSuffix ? `${stem}-${appliedRenameSuffix}` : undefined,
      })
      return {
        outcome: cacheOutcome,
        repoPath,
        sanitizedName: input.filename,
        bundleRepoPath,
        manifest,
        appliedRenameSuffix,
      }
    } catch (err) {
      return await recordHookFailure({
        input,
        stem,
        kind,
        manifestSource,
        repoPath,
        bundleRepoPath,
        cache,
        cacheOutcome,
        appliedRenameSuffix,
        startedAt,
        reason: `舊式 Office 檔案解析錯誤：${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  // 7c. .docx → docxmcp.extract_all (fast phase) + spawn poll loop
  if (kind === "docx") {
    try {
      await runDocxExtractAll({
        repoPath,
        projectRoot: input.projectRoot,
      })
      const manifest = await readManifest(stemDir)
      // Spawn poll loop only when the manifest reports running (the
      // expected path for docx). If extract_all already returned
      // background_status: done (very small docx), skip polling.
      if (manifest?.decompose.background_status === "running") {
        startPollLoop({
          stem,
          repoPath,
          projectRoot: input.projectRoot,
          appId: DOCXMCP_APP_ID,
        })
      }
      await emitTelemetry({
        input,
        stem,
        kind,
        cache,
        cacheOutcome,
        status: manifest?.decompose.status ?? "ok",
        decomposer: "docxmcp.extract_all",
        durationMs: Math.round(performance.now() - startedAt),
        priorSibling: appliedRenameSuffix ? `${stem}-${appliedRenameSuffix}` : undefined,
      })
      return {
        outcome: cacheOutcome,
        repoPath,
        sanitizedName: input.filename,
        bundleRepoPath,
        manifest,
        appliedRenameSuffix,
      }
    } catch (err) {
      const reason = formatDocxmcpError(err)
      return await recordHookFailure({
        input,
        stem,
        kind,
        manifestSource,
        repoPath,
        bundleRepoPath,
        cache,
        cacheOutcome,
        appliedRenameSuffix,
        startedAt,
        reason,
      })
    }
  }

  // Should never reach here (classifyOffice covers all kinds).
  throw new Error(`unhandled office kind: ${kind}`)
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Run docxmcp's extract_all (fast phase). Uploads the file via the
 * mcp app's /files endpoint, calls extract_all over MCP with a 30 s
 * hard timeout, lands the returned bundle into the bundle dir.
 */
async function runDocxExtractAll(input: {
  repoPath: string
  projectRoot: string
}): Promise<void> {
  // Step 1: upload bytes → token
  const upload = await IncomingDispatcher.uploadFileForApp({
    appId: DOCXMCP_APP_ID,
    repoPath: input.repoPath,
    projectRoot: input.projectRoot,
    toolName: DOCXMCP_TOOL_EXTRACT_ALL,
  })
  if (!upload) {
    throw new Error("docxmcp /files upload failed (transport)")
  }

  // Step 2: call extract_all (with 30 s hard timeout via AbortController)
  const clients = await MCP.clients()
  const client = clients[`mcpapp-${DOCXMCP_APP_ID}`] ?? clients[DOCXMCP_APP_ID]
  if (!client) {
    await IncomingDispatcher.deleteTokenForApp(DOCXMCP_APP_ID, upload.token).catch(() => {})
    throw new Error("docxmcp mcp client not connected")
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FAST_PHASE_TIMEOUT_MS)
  let result
  try {
    result = await client.callTool(
      {
        name: DOCXMCP_TOOL_EXTRACT_ALL,
        arguments: { token: upload.token, doc_dir: input.repoPath },
      },
      CallToolResultSchema,
      { signal: ctrl.signal, timeout: FAST_PHASE_TIMEOUT_MS, resetTimeoutOnProgress: false },
    )
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error(
        `docxmcp 服務暫時無回應 (timeout ${FAST_PHASE_TIMEOUT_MS / 1000}s)`,
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }

  // Step 3: extract bundle into bundle dir
  const sc = (result as { structuredContent?: { bundle_tar_b64?: string; from_cache?: boolean } })
    .structuredContent
  if (!sc?.bundle_tar_b64) {
    throw new Error("docxmcp extract_all returned no bundle (unexpected)")
  }
  await IncomingDispatcher.publishBundleForApp({
    appId: DOCXMCP_APP_ID,
    repoPath: input.repoPath,
    projectRoot: input.projectRoot,
    tarB64: sc.bundle_tar_b64,
    fromCache: !!sc.from_cache,
  })
}

function formatDocxmcpError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes("timeout") || msg.includes("逾時")) {
    return `docxmcp 服務暫時無回應 (timeout ${FAST_PHASE_TIMEOUT_MS / 1000}s)`
  }
  if (msg.includes("not connected")) {
    return "docx 處理工具暫不可用，請聯繫管理員更新"
  }
  if (msg.includes("token_not_found")) {
    return "docxmcp 暫存權杖失效，請重新上傳"
  }
  return `docxmcp 處理錯誤：${msg.slice(0, 160)}`
}

interface RecordHookFailureInput {
  input: LandOfficeInput
  stem: string
  kind: OfficeKind
  manifestSource: ManifestSource
  repoPath: string
  bundleRepoPath: string
  cache: "hit" | "miss"
  cacheOutcome: "fresh" | "regen"
  appliedRenameSuffix: string | undefined
  startedAt: number
  reason: string
}

async function recordHookFailure(args: RecordHookFailureInput): Promise<LandOfficeResult> {
  const durationMs = Math.round(performance.now() - args.startedAt)
  await recordFailure({
    stem: args.stem,
    source: args.manifestSource,
    reason: args.reason,
    durationMs,
    projectRoot: args.input.projectRoot,
  }).catch((err) => {
    log.error("recordFailure ALSO threw — manifest may be missing", {
      stem: args.stem,
      reason: args.reason,
      error: err instanceof Error ? err.message : String(err),
    })
  })
  const manifest = await readManifest(stemDirForStem(args.stem, args.input.projectRoot))
  await emitTelemetry({
    input: args.input,
    stem: args.stem,
    kind: args.kind,
    cache: args.cache,
    cacheOutcome: args.cacheOutcome,
    status: "failed",
    reason: args.reason,
    decomposer: "opencode.failure_recorder",
    durationMs,
    priorSibling: args.appliedRenameSuffix ? `${args.stem}-${args.appliedRenameSuffix}` : undefined,
  })
  return {
    outcome: "failed",
    repoPath: args.repoPath,
    sanitizedName: args.input.filename,
    bundleRepoPath: args.bundleRepoPath,
    manifest,
    appliedRenameSuffix: args.appliedRenameSuffix,
  }
}

interface EmitTelemetryInput {
  input: LandOfficeInput
  stem: string
  kind: OfficeKind
  cache: "hit" | "miss"
  cacheOutcome: "hit" | "fresh" | "regen"
  status: "ok" | "failed" | "unsupported"
  reason?: string
  decomposer?: string
  durationMs: number
  priorSibling?: string
}

async function emitTelemetry(args: EmitTelemetryInput): Promise<void> {
  await Bus.publish(DecomposeOutcome, {
    mime: args.input.mime,
    format: args.kind as "docx" | "doc" | "xls" | "ppt" | "xlsx" | "pptx",
    byteSize: args.input.bytes.byteLength,
    durationMs: args.durationMs,
    cache: args.cache,
    cacheOutcome: args.cacheOutcome,
    status: args.status,
    reason: args.reason,
    decomposer: args.decomposer,
    stem: args.stem,
    priorSibling: args.priorSibling,
  }).catch((err) => {
    log.warn("telemetry emit failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

// Suppress the unused-import warning for paths that are only used
// transitively through type assertions above. (Bun's TS treats these
// as "unused" otherwise.)
void existsSync
