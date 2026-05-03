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
      return
    }

    const bgStatus = manifest?.decompose.background_status
    if (bgStatus !== "running") {
      log.info("poll loop done", { stem: input.stem, bgStatus })
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
}

/**
 * One poll cycle: call extract_all_collect, land any new files, return
 * the latest manifest.
 */
async function pollOnce(input: StartPollLoopInput): Promise<Manifest | null> {
  const clients = await MCP.clients()
  const client = clients[`mcpapp-${input.appId}`] ?? clients[input.appId]
  if (!client) throw new Error("docxmcp mcp client not connected")

  // We need the token. The fast-phase upload obtained one but didn't
  // surface it to us. extract_all_collect on docxmcp accepts a doc_dir
  // path argument; since the dispatcher's path-rewriting layer will
  // re-upload + re-tokenise the path on each call, the polling loop
  // can pass the repo-relative path and let the dispatcher handle
  // tokenisation via its existing AI-tool flow. BUT — the dispatcher's
  // before() is wired for AI tool calls, not server-initiated ones.
  //
  // Simplest: re-upload the source file each poll to get a fresh
  // token. This is wasteful but bounded (up to 12 polls × small
  // upload cost on a local Unix socket). Future optimisation: keep
  // the original token alive across polls (requires plumbing it from
  // the hook into this loop).
  const upload = await IncomingDispatcher.uploadFileForApp({
    appId: input.appId,
    repoPath: input.repoPath,
    projectRoot: input.projectRoot,
    toolName: DOCXMCP_TOOL_COLLECT,
  })
  if (!upload) throw new Error("docxmcp /files re-upload failed")

  let result
  try {
    result = await client.callTool(
      {
        name: DOCXMCP_TOOL_COLLECT,
        arguments: { token: upload.token, doc_dir: input.repoPath, wait: 0 },
      },
      CallToolResultSchema,
      { timeout: POLL_INTERVAL_MS, resetTimeoutOnProgress: false },
    )
  } finally {
    await IncomingDispatcher.deleteTokenForApp(input.appId, upload.token).catch(() => {})
  }

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
