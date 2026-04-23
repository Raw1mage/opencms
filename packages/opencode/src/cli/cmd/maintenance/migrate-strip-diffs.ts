import type { Argv } from "yargs"
import fs from "fs/promises"
import path from "path"
import { cmd } from "../cmd"
import { Global } from "../../../global"
import { Log } from "../../../util/log"

/**
 * mobile-session-restructure (2026-04-23) — one-shot migration.
 *
 * Walks ~/.local/share/opencode/storage/session/ (per Global.Path.data)
 * and rewrites every user message's info.json to drop `before` and
 * `after` fields from each entry in `summary.diffs[]`. Keeps all other
 * fields (file, additions, deletions, status).
 *
 * Per-session atomicity: the per-session marker
 * `<session>/.diff-migration-v1.done` is written LAST. A crash
 * mid-session leaves the marker absent; re-running picks the session up
 * fresh. Atomic per-file (temp + rename) so no file is half-rewritten.
 *
 * OPERATOR must take a backup first:
 *   cp -a ~/.local/share/opencode/storage/session/ \
 *         ~/.local/share/opencode/storage/session.bak-$(date +%Y%m%d-%H%M)/
 *
 * See /specs/mobile-session-restructure/ for full spec.
 */

const log = Log.create({ service: "diff-migration" })
const MARKER_NAME = ".diff-migration-v1.done"

interface Counters {
  sessionsProcessed: number
  sessionsSkipped: number
  messagesTouched: number
  bytesReclaimed: number
  malformedInfoCount: number
  writeFailures: number
}

export const MigrateStripDiffsCommand = cmd({
  command: "maintenance:migrate-strip-diffs",
  describe:
    "[mobile-session-restructure] Strip before/after from every stored message summary.diffs[]. Reclaims ~90% of session disk usage. Take a cp -a backup first.",
  builder: (yargs: Argv) => {
    return yargs
      .option("dry-run", {
        describe: "Report what would change; do not write.",
        type: "boolean",
        default: false,
      })
      .option("session", {
        describe: "Limit to one session ID (for validation).",
        type: "string",
      })
      .option("verbose", {
        describe: "Log every message processed.",
        type: "boolean",
        default: false,
      })
  },
  handler: async (args) => {
    const dryRun = Boolean(args["dry-run"])
    const onlySession = args.session as string | undefined
    const verbose = Boolean(args.verbose)

    const sessionRoot = path.join(Global.Path.data, "storage", "session")
    log.info("migration start", { sessionRoot, dryRun, onlySession })

    let entries: string[]
    try {
      entries = await fs.readdir(sessionRoot)
    } catch (e) {
      log.error("cannot read session root", { sessionRoot, error: String(e) })
      process.exitCode = 1
      return
    }

    const counters: Counters = {
      sessionsProcessed: 0,
      sessionsSkipped: 0,
      messagesTouched: 0,
      bytesReclaimed: 0,
      malformedInfoCount: 0,
      writeFailures: 0,
    }

    for (const entry of entries) {
      if (!entry.startsWith("ses_")) continue
      if (onlySession && entry !== onlySession) continue

      const sessionDir = path.join(sessionRoot, entry)
      const markerPath = path.join(sessionDir, MARKER_NAME)

      try {
        await fs.access(markerPath)
        counters.sessionsSkipped++
        if (verbose) log.info("session already migrated — skipping", { sessionID: entry })
        continue
      } catch {
        // marker absent — proceed
      }

      const messagesDir = path.join(sessionDir, "messages")
      let messageDirs: string[]
      try {
        messageDirs = await fs.readdir(messagesDir)
      } catch {
        // session has no messages dir (edge case); treat as already done
        if (!dryRun) await fs.writeFile(markerPath, emptyMarker(counters)).catch(() => {})
        counters.sessionsProcessed++
        continue
      }

      let sessionMessagesTouched = 0
      let sessionBytesReclaimed = 0
      let sessionHadFailure = false

      for (const msgDirName of messageDirs) {
        const infoPath = path.join(messagesDir, msgDirName, "info.json")

        let infoText: string
        let infoStatSize: number
        try {
          const stat = await fs.stat(infoPath)
          if (!stat.isFile()) continue
          infoStatSize = stat.size
          infoText = await fs.readFile(infoPath, "utf-8")
        } catch {
          // info.json missing or unreadable — skip this message silently
          continue
        }

        let info: any
        try {
          info = JSON.parse(infoText)
        } catch (e) {
          counters.malformedInfoCount++
          sessionHadFailure = true
          log.warn("malformed info.json — skipping message", {
            sessionID: entry,
            messageDir: msgDirName,
            error: String(e),
          })
          continue
        }

        const diffs = info?.summary?.diffs
        if (!Array.isArray(diffs) || diffs.length === 0) continue

        let anyChanged = false
        for (const d of diffs) {
          if (d && typeof d === "object") {
            if ("before" in d) {
              delete d.before
              anyChanged = true
            }
            if ("after" in d) {
              delete d.after
              anyChanged = true
            }
          }
        }

        if (!anyChanged) continue

        if (dryRun) {
          sessionMessagesTouched++
          const newText = JSON.stringify(info, null, 2)
          sessionBytesReclaimed += Math.max(0, infoStatSize - Buffer.byteLength(newText, "utf-8"))
          if (verbose)
            log.info("would slim", {
              sessionID: entry,
              messageDir: msgDirName,
              oldBytes: infoStatSize,
              newBytes: Buffer.byteLength(newText, "utf-8"),
            })
          continue
        }

        const newText = JSON.stringify(info, null, 2)
        const tmpPath = `${infoPath}.tmp`
        try {
          await fs.writeFile(tmpPath, newText, "utf-8")
          await fs.rename(tmpPath, infoPath)
          sessionMessagesTouched++
          sessionBytesReclaimed += Math.max(0, infoStatSize - Buffer.byteLength(newText, "utf-8"))
          if (verbose)
            log.info("slimmed", {
              sessionID: entry,
              messageDir: msgDirName,
              oldBytes: infoStatSize,
              newBytes: Buffer.byteLength(newText, "utf-8"),
            })
        } catch (e) {
          counters.writeFailures++
          sessionHadFailure = true
          log.error("write failed — aborting session", {
            sessionID: entry,
            messageDir: msgDirName,
            error: String(e),
          })
          // clean up any leftover tmp
          await fs.unlink(tmpPath).catch(() => undefined)
          break
        }
      }

      counters.messagesTouched += sessionMessagesTouched
      counters.bytesReclaimed += sessionBytesReclaimed

      if (sessionHadFailure) {
        log.warn("session partial — marker withheld; re-run will retry", {
          sessionID: entry,
          messagesTouched: sessionMessagesTouched,
          bytesReclaimed: sessionBytesReclaimed,
        })
        continue
      }

      if (!dryRun) {
        const marker = {
          version: 1,
          migratedAt: new Date().toISOString(),
          messagesTouched: sessionMessagesTouched,
          bytesReclaimed: sessionBytesReclaimed,
        }
        try {
          await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), "utf-8")
        } catch (e) {
          log.error("failed to write session marker — session will re-process next run", {
            sessionID: entry,
            error: String(e),
          })
          continue
        }
      }

      counters.sessionsProcessed++
      if (verbose || sessionMessagesTouched > 0)
        log.info("session done", {
          sessionID: entry,
          messagesTouched: sessionMessagesTouched,
          bytesReclaimed: sessionBytesReclaimed,
          dryRun,
        })
    }

    log.info("migration complete", counters)

    const summaryLines = [
      "",
      `  sessions processed: ${counters.sessionsProcessed}`,
      `  sessions skipped (already migrated): ${counters.sessionsSkipped}`,
      `  messages touched: ${counters.messagesTouched}`,
      `  bytes reclaimed: ${(counters.bytesReclaimed / 1024 / 1024).toFixed(1)} MB`,
      `  malformed info.json: ${counters.malformedInfoCount}`,
      `  write failures: ${counters.writeFailures}`,
      dryRun ? "  [DRY RUN — no files written]" : "",
    ]
    process.stderr.write(summaryLines.join("\n") + "\n")

    if (counters.malformedInfoCount > 0 || counters.writeFailures > 0) process.exitCode = 1
  },
})

function emptyMarker(_counters: Counters) {
  return JSON.stringify(
    {
      version: 1,
      migratedAt: new Date().toISOString(),
      messagesTouched: 0,
      bytesReclaimed: 0,
      note: "session had no messages dir",
    },
    null,
    2,
  )
}
