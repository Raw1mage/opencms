/**
 * Per-stem polling loop for the docxmcp background phase.
 *
 * After the dispatch hook lands the fast-phase bundle, it spawns this
 * loop to incrementally pull the background extras (body / chapters /
 * tables / media) into the host's incoming/<stem>/ tree as docxmcp
 * produces them.
 *
 * Mechanics (DD-11 + DD-14):
 *   - Every POLL_INTERVAL_MS (default 5_000), call extract_all_collect
 *     with wait=0. The docxmcp-side _last_bundled_state ensures we
 *     only ship files that are new since the previous poll.
 *   - Stop when the returned manifest's background_status != "running"
 *     OR after POLL_SAFETY_CAP_MS (default 180_000).
 *   - On token_not_found (container restarted mid-flight), record a
 *     synthetic background_failed manifest and stop.
 *   - The loop is fire-and-forget: the dispatch hook does not await it.
 *     Errors here log and stop the loop; they do not bubble to the
 *     user.
 */

import path from "node:path"
import fs from "node:fs/promises"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Log } from "../util/log"
import { IncomingDispatcher } from "./dispatcher"
import { MCP } from "../mcp"
import {
  readManifest,
  writeManifest,
  stemDirForStem,
  type Manifest,
} from "./manifest"

const log = Log.create({ service: "incoming.poll-loop" })

export const POLL_INTERVAL_MS = 5_000
export const POLL_SAFETY_CAP_MS = 180_000
export const DOCXMCP_TOOL_COLLECT = "extract_all_collect"

export interface StartPollLoopInput {
  stem: string
  /** repo-relative path to the source file (e.g. "incoming/foo.docx"). */
  repoPath: string
  projectRoot: string
  appId: string
  /**
   * Token from the original extract_all call. CRITICAL: docxmcp's
   * background phase is bound to a SPECIFIC token's doc_dir. Earlier
   * versions of this loop re-uploaded the file each cycle to obtain a
   * fresh token, but every collect call then ran against an empty
   * fresh token_dir and saw NO progress — the actual background was
   * orphaned in the original token_dir. The hook now passes through
   * the original token; the loop reuses it for every poll.
   */
  token: string
}

/**
 * Start the loop. Returns immediately; the loop runs in the
 * background. Multiple calls for the same stem in quick succession
 * are safe — we record a per-stem "active" set so a second call
 * within the cap window is ignored.
 */
export function startPollLoop(input: StartPollLoopInput): void {
  if (activeStems.has(input.stem)) {
    log.info("poll loop already active; skipping duplicate start", { stem: input.stem })
    return
  }
  activeStems.add(input.stem)
  void runLoop(input).finally(() => activeStems.delete(input.stem))
}

const activeStems = new Set<string>()

async function runLoop(input: StartPollLoopInput): Promise<void> {
  const startedAt = Date.now()
  log.info("poll loop start", { stem: input.stem, cap_ms: POLL_SAFETY_CAP_MS })

  while (Date.now() - startedAt < POLL_SAFETY_CAP_MS) {
    await sleep(POLL_INTERVAL_MS)

    let manifest: Manifest | null
    try {
      manifest = await pollOnce(input)
    } catch (err) {
      const reason = formatCollectError(err)
      log.warn("poll cycle error; recording bg_failed and stopping", {
        stem: input.stem,
        reason,
      })
      await markBackgroundFailed(input, reason).catch((markErr) => {
        log.error("markBackgroundFailed ALSO threw", {
          stem: input.stem,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        })
      })
      await cleanupToken(input)
      return
    }

    const bgStatus = manifest?.decompose.background_status
    if (bgStatus !== "running") {
      log.info("poll loop done", { stem: input.stem, bgStatus })
      // Bug fix 2026-05-03: bundle producer ships new files but does
      // NOT ship file deletions. _PENDING.md markers were created at
      // fast-phase return and the docxmcp-side background phase deletes
      // them inside the container; that deletion never reaches the
      // host. Clean them up here on the host side as part of the loop's
      // terminal step. Idempotent (rmSync force ignores ENOENT).
      if (bgStatus === "done") {
        await cleanupPendingMarkers(input)
      }
      await cleanupToken(input)
      return
    }
  }

  // Safety cap fired; background still running per last manifest read.
  // Per spec: surface "background extraction taking longer than expected"
  // by leaving manifest in `running` state and logging.
  log.warn("poll loop safety cap reached; leaving manifest in running state", {
    stem: input.stem,
    cap_ms: POLL_SAFETY_CAP_MS,
  })
  await cleanupToken(input)
}

/**
 * One poll cycle: call extract_all_collect against the ORIGINAL
 * extract_all token (so the docxmcp-side background phase the call
 * looks at is actually the one we care about), land any new files
 * in the bundle, return the latest manifest.
 */
async function pollOnce(input: StartPollLoopInput): Promise<Manifest | null> {
  const clients = await MCP.clients()
  const client = clients[`mcpapp-${input.appId}`] ?? clients[input.appId]
  if (!client) throw new Error("docxmcp mcp client not connected")

  let result
  result = await client.callTool(
    {
      name: DOCXMCP_TOOL_COLLECT,
      arguments: { token: input.token, doc_dir: input.repoPath, wait: 0 },
    },
    CallToolResultSchema,
    { timeout: POLL_INTERVAL_MS, resetTimeoutOnProgress: false },
  )

  const sc = (result as { structuredContent?: { bundle_tar_b64?: string; from_cache?: boolean } })
    .structuredContent
  if (sc?.bundle_tar_b64) {
    await IncomingDispatcher.publishBundleForApp({
      appId: input.appId,
      repoPath: input.repoPath,
      projectRoot: input.projectRoot,
      tarB64: sc.bundle_tar_b64,
      fromCache: !!sc.from_cache,
    })
  }

  const stemDir = stemDirForStem(input.stem, input.projectRoot)
  return await readManifest(stemDir)
}

/**
 * After polling completes (success / failure / safety cap), best-
 * effort delete the token so docxmcp's session storage doesn't grow
 * unbounded. Called from runLoop's terminal paths.
 */
async function cleanupToken(input: StartPollLoopInput): Promise<void> {
  await IncomingDispatcher.deleteTokenForApp(input.appId, input.token).catch(() => {})
}

/**
 * Best-effort removal of host-side _PENDING.md markers when the
 * background phase finishes. The bundle producer only ships new /
 * modified files, never deletions, so the markers (created at fast-
 * phase return + deleted in the container by the background phase)
 * persist on the host until we clean them up here.
 */
async function cleanupPendingMarkers(input: StartPollLoopInput): Promise<void> {
  const stemDir = stemDirForStem(input.stem, input.projectRoot)
  for (const sub of ["chapters", "tables", "media"]) {
    const marker = path.join(stemDir, sub, "_PENDING.md")
    await fs.rm(marker, { force: true }).catch((err) => {
      log.warn("cleanupPendingMarkers: rm failed (non-fatal)", {
        stem: input.stem,
        marker,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}

async function markBackgroundFailed(input: StartPollLoopInput, reason: string): Promise<void> {
  const stemDir = stemDirForStem(input.stem, input.projectRoot)
  const manifest = await readManifest(stemDir)
  if (!manifest) return
  manifest.decompose.background_status = "failed"
  manifest.decompose.background_error = reason
  await writeManifest(stemDir, manifest)
  // Best-effort: leave _PENDING.md markers in place per spec — they
  // signal something went wrong.
  void path
  void fs
}

function formatCollectError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes("token_not_found")) {
    return "docxmcp 容器在拆解進行中重啟，部分內容遺失。可重新上傳此檔重試。"
  }
  if (msg.includes("not connected")) {
    return "docx 處理工具暫不可用，請聯繫管理員更新。"
  }
  return `背景拆解輪詢錯誤：${msg.slice(0, 160)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
