#!/usr/bin/env bun
/**
 * migrate-orphaned-sessions.ts
 *
 * One-time migration: fix sessions orphaned by a repo directory move.
 *
 * Problem:
 *   - Repo moved from /home/pkcs12/opencode → /home/pkcs12/projects/opencode
 *   - 270 sessions still have the old directory + old projectID (4b0ea68d...)
 *   - listGlobal() filtered them out (exact directory match)
 *
 * Fix:
 *   - Update session info.json: directory → new path, projectID → current ID
 *   - Update index/session/*.json: projectID → current ID
 *
 * Usage:
 *   bun run scripts/migrate-orphaned-sessions.ts [--dry-run]
 */

import fs from "fs"
import path from "path"

const STORAGE_ROOT = path.join(
  process.env.HOME ?? "/home/pkcs12",
  ".local/share/opencode/storage",
)
const SESSION_DIR = path.join(STORAGE_ROOT, "session")
const INDEX_DIR = path.join(STORAGE_ROOT, "index", "session")

// Migration mapping: { oldDirectory → { newDirectory, oldProjectID, newProjectID } }
const MIGRATIONS = [
  {
    oldDirectory: "/home/pkcs12/opencode",
    oldProjectID: "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750",
    newDirectory: "/home/pkcs12/projects/opencode",
    newProjectID: "8c49a58599a1fccb5a97690e4a3a6e17858cdf8f",
  },
  {
    oldDirectory: "/home/opencode",
    oldProjectID: "global",
    newDirectory: "/home/pkcs12/projects/opencode",
    newProjectID: "8c49a58599a1fccb5a97690e4a3a6e17858cdf8f",
  },
]

const dryRun = process.argv.includes("--dry-run")

async function main() {
  if (dryRun) console.log("[DRY RUN] No files will be modified.\n")

  let totalUpdated = 0
  let totalSkipped = 0
  let totalErrors = 0

  const sessionDirs = fs.readdirSync(SESSION_DIR).filter((d) => d.startsWith("ses_"))
  console.log(`Scanning ${sessionDirs.length} sessions...\n`)

  for (const sessionID of sessionDirs) {
    const infoPath = path.join(SESSION_DIR, sessionID, "info.json")
    if (!fs.existsSync(infoPath)) continue

    let info: Record<string, unknown>
    try {
      info = JSON.parse(fs.readFileSync(infoPath, "utf-8"))
    } catch {
      console.error(`  ERROR: failed to parse ${infoPath}`)
      totalErrors++
      continue
    }

    const migration = MIGRATIONS.find(
      (m) => info.directory === m.oldDirectory && info.projectID === m.oldProjectID,
    )
    if (!migration) {
      totalSkipped++
      continue
    }

    // Update session info.json
    const oldDir = info.directory
    info.directory = migration.newDirectory
    info.projectID = migration.newProjectID

    if (!dryRun) {
      fs.writeFileSync(infoPath, JSON.stringify(info, null, 2))
    }
    console.log(
      `  ${dryRun ? "[DRY]" : "FIXED"} ${sessionID}: ${oldDir} → ${migration.newDirectory}`,
    )

    // Update index file
    const indexPath = path.join(INDEX_DIR, `${sessionID}.json`)
    if (fs.existsSync(indexPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"))
        if (index.projectID === migration.oldProjectID) {
          index.projectID = migration.newProjectID
          if (!dryRun) {
            fs.writeFileSync(indexPath, JSON.stringify(index, null, 2))
          }
        }
      } catch {
        console.error(`  WARNING: failed to update index for ${sessionID}`)
      }
    }

    totalUpdated++
  }

  console.log(`\nDone.`)
  console.log(`  Updated: ${totalUpdated}`)
  console.log(`  Skipped: ${totalSkipped}`)
  console.log(`  Errors:  ${totalErrors}`)
  if (dryRun) console.log(`\nRe-run without --dry-run to apply changes.`)
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
