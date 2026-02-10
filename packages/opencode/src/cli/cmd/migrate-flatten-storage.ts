import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Log } from "../../util/log"
import { Global } from "../../global"
import { bootstrap } from "../bootstrap"
import path from "path"
import fs from "fs/promises"

const log = Log.create({ service: "migrate-flatten-storage" })

export const migrateFlattenStorage = cmd({
  command: "migrate-flatten-storage",
  describe: "Migrate session storage from session/<projectID>/<sessionID>/ to session/<sessionID>/ with symlinks",
  builder: (yargs: Argv) => {
    return yargs
      .option("dry-run", {
        type: "boolean",
        describe: "Preview changes without executing",
        default: false,
      })
      .option("force", {
        type: "boolean",
        describe: "Force migration even if target exists",
        default: false,
      })
  },
  handler: async (argv) => {
    await bootstrap(process.cwd(), async () => {
      const dryRun = argv.dryRun
      const force = argv.force

      const storageDir = path.join(Global.Path.data, "storage")
      const sessionRoot = path.join(storageDir, "session")

      log.info("Starting storage migration", { storageDir, dryRun, force })

      try {
        const stats = {
          scanned: 0,
          migrated: 0,
          skipped: 0,
          errors: 0,
          symlinksCreated: 0,
        }

        // 掃描所有 projectID 目錄
        const projectDirs = await fs.readdir(sessionRoot, { withFileTypes: true })

        for (const projectDir of projectDirs) {
          if (!projectDir.isDirectory()) continue
          if (projectDir.name === "index") continue // Skip index directory

          const projectID = projectDir.name
          const projectPath = path.join(sessionRoot, projectID)

          log.info(`Scanning project: ${projectID}`)

          const sessionDirs = await fs.readdir(projectPath, { withFileTypes: true })

          for (const sessionDir of sessionDirs) {
            stats.scanned++

            // 跳過舊的 .json 檔案
            if (!sessionDir.isDirectory()) {
              log.debug(`Skipping file: ${sessionDir.name}`)
              continue
            }

            const sessionID = sessionDir.name
            const oldPath = path.join(projectPath, sessionID)
            const newPath = path.join(sessionRoot, sessionID)
            const symlinkPath = oldPath

            // 檢查是否已經是 symlink
            const oldStat = await fs.lstat(oldPath).catch(() => null)
            if (oldStat?.isSymbolicLink()) {
              log.info(`Already symlink: ${sessionID}`)
              stats.skipped++
              continue
            }

            // 檢查新位置是否已存在
            const newExists = await fs
              .access(newPath)
              .then(() => true)
              .catch(() => false)

            if (newExists && !force) {
              log.warn(`Target exists, skipping: ${sessionID}`)
              stats.skipped++
              continue
            }

            // 檢查 info.json 確保這是有效的 session 目錄
            const infoPath = path.join(oldPath, "info.json")
            const hasInfo = await fs
              .access(infoPath)
              .then(() => true)
              .catch(() => false)

            if (!hasInfo) {
              log.warn(`No info.json, skipping: ${sessionID}`)
              stats.skipped++
              continue
            }

            // 讀取並驗證 session info
            try {
              const info = JSON.parse(await fs.readFile(infoPath, "utf-8"))
              if (info.projectID !== projectID) {
                log.warn(`ProjectID mismatch in ${sessionID}: expected ${projectID}, got ${info.projectID}`)
              }
            } catch (e) {
              log.error(`Failed to parse info.json for ${sessionID}`, e)
              stats.errors++
              continue
            }

            if (dryRun) {
              log.info(`[DRY RUN] Would migrate: ${oldPath} -> ${newPath}`)
              log.info(`[DRY RUN] Would create symlink: ${symlinkPath} -> ../../${sessionID}`)
              stats.migrated++
            } else {
              try {
                // 1. 移動目錄到新位置
                log.info(`Moving: ${oldPath} -> ${newPath}`)
                await fs.rename(oldPath, newPath)

                // 2. 創建反向 symlink（從舊位置指向新位置）
                const relativeTarget = path.relative(path.dirname(symlinkPath), newPath)
                log.info(`Creating symlink: ${symlinkPath} -> ${relativeTarget}`)
                await fs.symlink(relativeTarget, symlinkPath, "dir")

                stats.migrated++
                stats.symlinksCreated++
              } catch (e) {
                log.error(`Failed to migrate ${sessionID}`, e)
                stats.errors++

                // 嘗試回滾
                try {
                  await fs.rename(newPath, oldPath).catch(() => {})
                } catch {
                  log.error(`Failed to rollback ${sessionID}`)
                }
              }
            }
          }
        }

        log.info("Migration complete", stats)

        if (dryRun) {
          console.log("\n=== DRY RUN SUMMARY ===")
          console.log("No actual changes were made. Run without --dry-run to execute.")
        } else {
          console.log("\n=== MIGRATION SUMMARY ===")
        }

        console.log(`Scanned:          ${stats.scanned}`)
        console.log(`Migrated:         ${stats.migrated}`)
        console.log(`Symlinks created: ${stats.symlinksCreated}`)
        console.log(`Skipped:          ${stats.skipped}`)
        console.log(`Errors:           ${stats.errors}`)

        if (stats.errors > 0) {
          console.log("\n⚠️  Some sessions failed to migrate. Check logs for details.")
          process.exit(1)
        }

        if (!dryRun && stats.migrated > 0) {
          console.log("\n✅ Migration successful!")
          console.log("\nOld code will continue to work via symlinks.")
          console.log("New code will write to flat structure: session/<sessionID>/")
        }
      } catch (e) {
        log.error("Migration failed", e)
        console.error("Migration failed:", e)
        process.exit(1)
      }
    })
  },
})
