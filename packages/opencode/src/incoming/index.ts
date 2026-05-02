export { IncomingPaths } from "./paths"
export { IncomingHistory } from "./history"
export { IncomingDispatcher } from "./dispatcher"

import path from "node:path"
import fs from "node:fs/promises"
import { IncomingPaths } from "./paths"
import { IncomingHistory } from "./history"
import { IncomingDispatcher } from "./dispatcher"
import { Log } from "../util/log"

const log = Log.create({ service: "incoming.tool-hook" })

/**
 * Phase 4 helpers — patched into each opencode tool that writes to host fs.
 *
 * Pattern at the tool call site:
 *
 *   await maybeBreakIncomingHardLink(filepath)   // before write
 *   await Bun.write(filepath, content)
 *   await maybeAppendToolWriteHistory(filepath, "Write", ctx.sessionID)
 *
 * Both helpers are no-ops for paths outside <projectRoot>/incoming/, so
 * they are cheap to leave in place even when the tool is editing files
 * elsewhere in the repo.
 */

/**
 * If `filepath` is under <projectRoot>/incoming/ and the file is hard-
 * linked (st_nlink > 1), detach it before writing so the cache copy
 * doesn't get clobbered. Silent no-op otherwise.
 */
export async function maybeBreakIncomingHardLink(filepath: string): Promise<void> {
  let projectRoot: string
  try {
    projectRoot = IncomingPaths.projectRoot()
  } catch {
    return
  }
  const incomingAbs = path.join(projectRoot, IncomingPaths.INCOMING_DIR)
  const target = path.resolve(filepath)
  if (!target.startsWith(incomingAbs + path.sep) && target !== incomingAbs) return
  await IncomingDispatcher.breakHardLinkBeforeWrite(target).catch((err) => {
    log.warn("maybeBreakIncomingHardLink failed (non-fatal)", {
      filepath,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

/**
 * If `filepath` is under <projectRoot>/incoming/, append a `tool:<name>`
 * entry to the file's history journal (R6, SEQ-TOOL-WRITE-HOOK).
 * Filenames inside subfolders (e.g. incoming/<stem>/description.md) are
 * recorded against the leaf file basename — the journal lives next to
 * the bundle, not deep inside it. (Bundle-internal edits don't currently
 * have a per-file history; that's a v2 enhancement.)
 */
export async function maybeAppendToolWriteHistory(
  filepath: string,
  toolName: string,
  sessionID: string | null,
): Promise<void> {
  let projectRoot: string
  try {
    projectRoot = IncomingPaths.projectRoot()
  } catch {
    return
  }
  const incomingAbs = path.join(projectRoot, IncomingPaths.INCOMING_DIR)
  const target = path.resolve(filepath)
  if (!target.startsWith(incomingAbs + path.sep)) return

  // Determine which slot's history this write affects. If the file is
  // directly in incoming/ (e.g. incoming/foo.docx), the history journal
  // is foo.docx.jsonl. If the file is inside a bundle subfolder
  // (e.g. incoming/foo/description.md), record under the bundle marker
  // "<stem>.bundle.jsonl" so traceability survives without polluting the
  // top-level slot's journal.
  const rel = path.relative(incomingAbs, target)
  const segments = rel.split(path.sep)
  let journalName: string
  if (segments.length === 1) {
    journalName = segments[0]!
  } else {
    journalName = `${segments[0]!}.bundle`
  }

  try {
    const stat = await fs.stat(target)
    const sha = await IncomingHistory.computeSha256(target)
    await IncomingHistory.appendEntry(
      journalName,
      IncomingHistory.makeEntry({
        source: toolName.startsWith("tool:") ? (toolName as IncomingHistory.SourceKind) : (`tool:${toolName}` as IncomingHistory.SourceKind),
        sha256: sha,
        sizeBytes: stat.size,
        mtime: Math.floor(stat.mtimeMs),
        sessionId: sessionID,
      }),
      { root: projectRoot, emitBus: true },
    )
  } catch (err) {
    log.warn("maybeAppendToolWriteHistory failed (non-fatal)", {
      filepath,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
