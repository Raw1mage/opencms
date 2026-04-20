import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { $ } from "bun"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"

export namespace Storage {
  const log = Log.create({ service: "storage" })

  const SESSION_INDEX_DIR = ["index", "session"]
  const MESSAGE_INDEX_DIR = ["index", "message"]

  type Migration = (dir: string) => Promise<void>

  const warnMigration = (operation: string, target: string, error: unknown) => {
    log.warn("session storage migration step failed", {
      operation,
      target,
      error,
    })
  }

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  const MIGRATIONS: Migration[] = [
    async (dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await Filesystem.isDir(project))) return
      for await (const projectDir of new Bun.Glob("*").scan({
        cwd: project,
        onlyFiles: false,
      })) {
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for await (const msgFile of new Bun.Glob("storage/session/message/*/*.json").scan({
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const json = await Bun.file(msgFile).json()
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await Filesystem.isDir(worktree))) continue
          const [id] = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(worktree)
            .text()
            .then((x) =>
              x
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
          if (!id) continue
          projectID = id

          await Bun.write(
            path.join(dir, "project", projectID + ".json"),
            JSON.stringify({
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            }),
          )

          log.info(`migrating sessions for project ${projectID}`)
          for await (const sessionFile of new Bun.Glob("storage/session/info/*.json").scan({
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const session = await Bun.file(sessionFile).json()
            await Bun.write(dest, JSON.stringify(session))
            log.info(`migrating messages for session ${session.id}`)
            for await (const msgFile of new Bun.Glob(`storage/session/message/${session.id}/*.json`).scan({
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const message = await Bun.file(msgFile).json()
              await Bun.write(dest, JSON.stringify(message))

              log.info(`migrating parts for message ${message.id}`)
              for await (const partFile of new Bun.Glob(`storage/session/part/${session.id}/${message.id}/*.json`).scan(
                {
                  cwd: fullProjectDir,
                  absolute: true,
                },
              )) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await Bun.file(partFile).json()
                log.info("copying", {
                  partFile,
                  dest,
                })
                await Bun.write(dest, JSON.stringify(part))
              }
            }
          }
        }
      }
    },
    async (dir) => {
      for await (const item of new Bun.Glob("session/*/*.json").scan({
        cwd: dir,
        absolute: true,
      })) {
        const session = await Bun.file(item).json()
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await Bun.file(path.join(dir, "session_diff", session.id + ".json")).write(JSON.stringify(diffs))
        await Bun.file(path.join(dir, "session", session.projectID, session.id + ".json")).write(
          JSON.stringify({
            ...session,
            summary: {
              additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
              deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
            },
          }),
        )
      }
    },
    // @event_2026-02-11_session_storage_unify
    // Migrate from split session/message/part layout into per-session directory layout:
    // session/<project>/<session>/info.json
    // session/<project>/<session>/messages/<message>/info.json
    // session/<project>/<session>/messages/<message>/parts/<part>.json
    // session/<project>/<session>/output/output_*
    async (dir) => {
      const sessionRoot = path.join(dir, "session")
      const messageRoot = path.join(dir, "message")
      const partRoot = path.join(dir, "part")
      const legacyToolOutputRoot = path.join(dir, "tool-output")

      const projectDirs = await fs.readdir(sessionRoot, { withFileTypes: true }).catch(() => [] as any[])
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue
        const projectID = projectDir.name
        const projectPath = path.join(sessionRoot, projectID)
        const entries = await fs.readdir(projectPath, { withFileTypes: true }).catch(() => [] as any[])

        // Migrate old session files: session/<project>/<session>.json -> session/<project>/<session>/info.json
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue
          const sessionID = path.basename(entry.name, ".json")
          const oldInfo = path.join(projectPath, entry.name)
          const newSessionDir = path.join(sessionRoot, sessionID) // Fixed: Flat session directory
          const newInfo = path.join(newSessionDir, "info.json")

          await fs
            .mkdir(newSessionDir, { recursive: true })
            .catch((error) => warnMigration("mkdir", newSessionDir, error))
          if (!(await Bun.file(newInfo).exists())) {
            const content = await Bun.file(oldInfo)
              .text()
              .catch((error) => {
                warnMigration("read", oldInfo, error)
                return ""
              })
            if (content) await Bun.write(newInfo, content)
          }

          await Bun.write(
            path.join(dir, ...SESSION_INDEX_DIR, `${sessionID}.json`),
            JSON.stringify({ projectID }, null, 2),
          ).catch((error) => warnMigration("write", path.join(dir, ...SESSION_INDEX_DIR, `${sessionID}.json`), error))

          // Migrate messages for session
          const oldMessageDir = path.join(messageRoot, sessionID)
          const oldMessageFiles = await fs.readdir(oldMessageDir, { withFileTypes: true }).catch(() => [] as any[])
          for (const msgFile of oldMessageFiles) {
            if (!msgFile.isFile() || !msgFile.name.endsWith(".json")) continue
            const messageID = path.basename(msgFile.name, ".json")
            const oldMessageInfo = path.join(oldMessageDir, msgFile.name)
            const newMessageDir = path.join(newSessionDir, "messages", messageID)
            const newMessageInfo = path.join(newMessageDir, "info.json")

            await fs
              .mkdir(newMessageDir, { recursive: true })
              .catch((error) => warnMigration("mkdir", newMessageDir, error))
            if (!(await Bun.file(newMessageInfo).exists())) {
              const content = await Bun.file(oldMessageInfo)
                .text()
                .catch((error) => {
                  warnMigration("read", oldMessageInfo, error)
                  return ""
                })
              if (content) await Bun.write(newMessageInfo, content)
            }

            await Bun.write(
              path.join(dir, ...MESSAGE_INDEX_DIR, `${messageID}.json`),
              JSON.stringify({ projectID, sessionID }, null, 2),
            ).catch((error) => warnMigration("write", path.join(dir, ...MESSAGE_INDEX_DIR, `${messageID}.json`), error))

            // Migrate parts for message
            const oldPartsDir = path.join(partRoot, messageID)
            const oldPartFiles = await fs.readdir(oldPartsDir, { withFileTypes: true }).catch(() => [] as any[])
            for (const partFile of oldPartFiles) {
              if (!partFile.isFile() || !partFile.name.endsWith(".json")) continue
              const partID = path.basename(partFile.name, ".json")
              const oldPartPath = path.join(oldPartsDir, partFile.name)
              const newPartPath = path.join(newMessageDir, "parts", `${partID}.json`)
              await fs
                .mkdir(path.dirname(newPartPath), { recursive: true })
                .catch((error) => warnMigration("mkdir", path.dirname(newPartPath), error))
              if (!(await Bun.file(newPartPath).exists())) {
                const content = await Bun.file(oldPartPath)
                  .text()
                  .catch((error) => {
                    warnMigration("read", oldPartPath, error)
                    return ""
                  })
                if (content) await Bun.write(newPartPath, content)
              }
            }
          }

          // Migrate session-scoped output files if present in legacy directories
          const oldToolOutputDir = path.join(legacyToolOutputRoot, sessionID)
          const oldToolOutputs = await fs.readdir(oldToolOutputDir, { withFileTypes: true }).catch(() => [] as any[])
          for (const out of oldToolOutputs) {
            if (!out.isFile()) continue
            const oldPath = path.join(oldToolOutputDir, out.name)
            const targetName = out.name.startsWith("output_") ? out.name : `output_${out.name}`
            const newPath = path.join(newSessionDir, "output", targetName)
            await fs
              .mkdir(path.dirname(newPath), { recursive: true })
              .catch((error) => warnMigration("mkdir", path.dirname(newPath), error))
            if (!(await Bun.file(newPath).exists())) {
              const content = await Bun.file(oldPath)
                .text()
                .catch((error) => {
                  warnMigration("read", oldPath, error)
                  return ""
                })
              if (content) await Bun.write(newPath, content)
            }
          }

          // Also migrate output_* accidentally written under legacy message/<session>
          for (const msgFile of oldMessageFiles) {
            if (!msgFile.isFile() || !msgFile.name.startsWith("output_")) continue
            const oldPath = path.join(oldMessageDir, msgFile.name)
            const newPath = path.join(newSessionDir, "output", msgFile.name)
            await fs
              .mkdir(path.dirname(newPath), { recursive: true })
              .catch((error) => warnMigration("mkdir", path.dirname(newPath), error))
            if (!(await Bun.file(newPath).exists())) {
              const content = await Bun.file(oldPath)
                .text()
                .catch((error) => {
                  warnMigration("read", oldPath, error)
                  return ""
                })
              if (content) await Bun.write(newPath, content)
            }
          }
        }
      }
    },
    // @event_2026-02-11_session_index_backfill
    // 1. Move sessions that were accidentally migrated into session/<projectID>/<sessionID>/ info session/<sessionID>/
    // 2. Ensure every session has an entry in index/session/
    async (dir) => {
      const sessionRoot = path.join(dir, "session")
      const entries = await fs.readdir(sessionRoot, { withFileTypes: true }).catch(() => [] as any[])

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        // If it's a project directory (not starting with 'ses_'), check for sessions inside
        if (!entry.name.startsWith("ses_")) {
          const projectID = entry.name
          const projectPath = path.join(sessionRoot, projectID)
          const subEntries = await fs.readdir(projectPath, { withFileTypes: true }).catch(() => [] as any[])
          for (const sub of subEntries) {
            if (!sub.isDirectory() || !sub.name.startsWith("ses_")) continue
            const sessionID = sub.name
            const oldPath = path.join(projectPath, sessionID)
            const newPath = path.join(sessionRoot, sessionID)
            if (!(await Bun.file(path.join(newPath, "info.json")).exists())) {
              log.info(`re-migrating session ${sessionID} from project ${projectID}`)
              await fs.mkdir(newPath, { recursive: true }).catch((error) => warnMigration("mkdir", newPath, error))
              // Move all contents
              const files = await fs.readdir(oldPath).catch(() => [] as string[])
              for (const f of files) {
                const fromPath = path.join(oldPath, f)
                const toPath = path.join(newPath, f)
                await fs
                  .rename(fromPath, toPath)
                  .catch((error) => warnMigration("rename", `${fromPath} -> ${toPath}`, error))
              }
            }
          }
          // Cleanup empty project dir
          const remaining = await fs.readdir(projectPath).catch(() => [] as string[])
          if (remaining.length === 0) {
            await fs.rmdir(projectPath).catch((error) => warnMigration("rmdir", projectPath, error))
          }
        }
      }

      // Backfill index for all sessions now in the flat directory
      const finalEntries = await fs.readdir(sessionRoot, { withFileTypes: true }).catch(() => [] as any[])
      for (const entry of finalEntries) {
        if (!entry.isDirectory() || !entry.name.startsWith("ses_")) continue
        const sessionID = entry.name
        const info = await readJSON<{ projectID: string; parentID?: string }>(
          path.join(sessionRoot, sessionID, "info.json"),
        )
        if (info?.projectID) {
          await upsertSessionIndex(dir, sessionID, info.projectID, info.parentID)
        }
      }
    },
    // @event_2026-02-11_rescue_orphaned_sessions
    // Rescue sessions that have messages in storage/message/<sid> but no info.json in storage/session/
    async (dir) => {
      const sessionRoot = path.join(dir, "session")
      const messageRoot = path.join(dir, "message")
      const legacyMessageDirs = await fs.readdir(messageRoot).catch(() => [] as string[])

      for (const sid of legacyMessageDirs) {
        if (!sid.startsWith("ses_")) continue
        const newSessionDir = path.join(sessionRoot, sid)
        const infoPath = path.join(newSessionDir, "info.json")

        if (await Bun.file(infoPath).exists()) continue

        const oldMsgDir = path.join(messageRoot, sid)
        const msgFiles = (await fs.readdir(oldMsgDir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"))
        if (msgFiles.length === 0) continue

        log.info(`rescuing orphaned session ${sid}`)
        await fs.mkdir(newSessionDir, { recursive: true }).catch(() => { })

        let firstMsg: any = {}
        try {
          // Sort messages by name (timestamp based) to find the earliest
          const sortedMsgs = msgFiles.sort()
          firstMsg = await Bun.file(path.join(oldMsgDir, sortedMsgs[0])).json()
        } catch (e) {
          log.error(`failed to read first message for rescue of ${sid}`, {
            error: e,
          })
        }

        const info: any = {
          id: sid,
          slug: sid,
          version: "local",
          projectID: firstMsg.projectID || "global",
          directory: firstMsg.path?.root || process.cwd(),
          title: "Rescued Session",
          time: {
            created: firstMsg.time?.created || Date.now(),
            updated: Date.now(),
          },
        }

        await Bun.write(infoPath, JSON.stringify(info, null, 2))
        await upsertSessionIndex(dir, sid, info.projectID, info.parentID)

        // Migrate messages to new structure: session/<sid>/messages/<mid>/info.json
        const newMsgRoot = path.join(newSessionDir, "messages")
        for (const msgFile of msgFiles) {
          const mid = path.basename(msgFile, ".json")
          const targetMsgDir = path.join(newMsgRoot, mid)
          const targetMsgInfo = path.join(targetMsgDir, "info.json")

          await fs.mkdir(targetMsgDir, { recursive: true }).catch(() => { })
          if (!(await Bun.file(targetMsgInfo).exists())) {
            await fs.copyFile(path.join(oldMsgDir, msgFile), targetMsgInfo).catch(() => { })
          }
        }
      }
    },
    // @event_2026-02-11_session_index_v2
    // Backfill parentID into session index files
    async (dir) => {
      const sessionRoot = path.join(dir, "session")
      const finalEntries = await fs.readdir(sessionRoot, { withFileTypes: true }).catch(() => [] as any[])
      for (const entry of finalEntries) {
        if (!entry.isDirectory() || !entry.name.startsWith("ses_")) continue
        const sessionID = entry.name
        const info = await readJSON<{ projectID: string; parentID?: string }>(
          path.join(sessionRoot, sessionID, "info.json"),
        )
        if (info?.projectID) {
          await upsertSessionIndex(dir, sessionID, info.projectID, info.parentID)
        }
      }
    },
  ]

  async function readJSON<T>(filePath: string): Promise<T | undefined> {
    return Bun.file(filePath)
      .json()
      .catch(() => undefined)
  }

  // @event_2026-02-11_remove_projectid_layer
  // Final Phase: Removed redundant projectID layer
  function sessionInfoPath(dir: string, sessionID: string) {
    return path.join(dir, "session", sessionID, "info.json")
  }

  function messageInfoPath(dir: string, _projectID: string, sessionID: string, messageID: string) {
    return path.join(dir, "session", sessionID, "messages", messageID, "info.json")
  }

  function partPath(dir: string, _projectID: string, sessionID: string, messageID: string, partID: string) {
    return path.join(dir, "session", sessionID, "messages", messageID, "parts", `${partID}.json`)
  }

  function sessionIndexPath(dir: string, sessionID: string) {
    return path.join(dir, ...SESSION_INDEX_DIR, `${sessionID}.json`)
  }

  function messageIndexPath(dir: string, messageID: string) {
    return path.join(dir, ...MESSAGE_INDEX_DIR, `${messageID}.json`)
  }

  async function upsertSessionIndex(dir: string, sessionID: string, projectID: string, parentID?: string) {
    const target = sessionIndexPath(dir, sessionID)
    await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => { })
    await Bun.write(target, JSON.stringify({ projectID, parentID }, null, 2))
  }

  async function upsertMessageIndex(dir: string, messageID: string, projectID: string, sessionID: string) {
    const target = messageIndexPath(dir, messageID)
    await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => { })
    await Bun.write(target, JSON.stringify({ projectID, sessionID }, null, 2))
  }

  async function resolveSessionProjectID(dir: string, sessionID: string): Promise<string | undefined> {
    const indexed = await readJSON<{ projectID: string; parentID?: string }>(sessionIndexPath(dir, sessionID))
    if (indexed?.projectID) return indexed.projectID

    const infoPath = sessionInfoPath(dir, sessionID)
    const info = await readJSON<{ projectID: string; parentID?: string }>(infoPath)
    if (info?.projectID) {
      await upsertSessionIndex(dir, sessionID, info.projectID, info.parentID)
      return info.projectID
    }
  }

  async function resolveMessageScope(
    dir: string,
    messageID: string,
  ): Promise<{ projectID: string; sessionID: string } | undefined> {
    const indexed = await readJSON<{ projectID: string; sessionID: string }>(messageIndexPath(dir, messageID))
    if (indexed?.projectID && indexed?.sessionID) return indexed

    const matchFlat = await Array.fromAsync(
      new Bun.Glob(`session/*/messages/${messageID}/info.json`).scan({ cwd: dir, onlyFiles: true }),
    )
    if (matchFlat[0]) {
      const parts = matchFlat[0].split(path.sep)
      const sessionID = parts[1]
      const info = await readJSON<{ projectID?: string }>(path.join(dir, matchFlat[0]))
      if (sessionID && info?.projectID) {
        await upsertMessageIndex(dir, messageID, info.projectID, sessionID)
        return { projectID: info.projectID, sessionID }
      }
    }
  }

  async function resolvePath(dir: string, key: string[]): Promise<string> {
    const [domain, a, b] = key
    if (domain === "session" && a) {
      // Key format: ["session", sessionID]
      const sessionID = b ?? a
      return sessionInfoPath(dir, sessionID)
    }

    if (domain === "message" && a && b) {
      // Key format: ["message", sessionID, messageID]
      return messageInfoPath(dir, "", a, b)
    }

    if (domain === "part" && a && b) {
      // Key format: ["part", messageID, partID]
      const messageID = a
      const partID = b

      const scope = await resolveMessageScope(dir, messageID)
      if (scope) {
        return partPath(dir, "", scope.sessionID, messageID, partID)
      }
    }

    return path.join(dir, ...key) + ".json"
  }

  export async function sessionDirectory(sessionID: string): Promise<string | undefined> {
    const dir = await state().then((x) => x.dir)
    const newPath = path.join(dir, "session", sessionID)
    if (await Bun.file(path.join(newPath, "info.json")).exists()) {
      return newPath
    }
  }

  /**
   * Cheap filesystem scan producing session-level size hints without
   * deserializing any part JSON. Used by the meta endpoint introduced in
   * specs/frontend-session-lazyload/ to let the webapp decide whether to
   * auto-redirect into a session before fetching its messages.
   */
  export async function sessionStats(sessionID: string): Promise<{
    messageCount: number
    partCount: number
    totalBytes: number
    lastUpdated: number
  } | undefined> {
    const sessionDir = await sessionDirectory(sessionID)
    if (!sessionDir) return undefined
    const messagesRoot = path.join(sessionDir, "messages")
    const messageEntries = await fs.readdir(messagesRoot, { withFileTypes: true }).catch(() => [] as any[])
    let messageCount = 0
    let partCount = 0
    let totalBytes = 0
    let lastUpdated = 0
    const infoStat = await fs.stat(path.join(sessionDir, "info.json")).catch(() => undefined)
    if (infoStat && infoStat.mtimeMs > lastUpdated) lastUpdated = infoStat.mtimeMs
    for (const entry of messageEntries) {
      if (!entry.isDirectory()) continue
      const messageDir = path.join(messagesRoot, entry.name)
      const messageInfo = path.join(messageDir, "info.json")
      const mStat = await fs.stat(messageInfo).catch(() => undefined)
      if (!mStat) continue
      messageCount += 1
      if (mStat.mtimeMs > lastUpdated) lastUpdated = mStat.mtimeMs
      const partsDir = path.join(messageDir, "parts")
      const partEntries = await fs.readdir(partsDir, { withFileTypes: true }).catch(() => [] as any[])
      for (const p of partEntries) {
        if (!p.isFile() || !p.name.endsWith(".json")) continue
        const pStat = await fs.stat(path.join(partsDir, p.name)).catch(() => undefined)
        if (!pStat) continue
        partCount += 1
        totalBytes += pStat.size
        if (pStat.mtimeMs > lastUpdated) lastUpdated = pStat.mtimeMs
      }
    }
    return { messageCount, partCount, totalBytes, lastUpdated }
  }

  const state = lazy(async () => {
    const dir = path.join(Global.Path.data, "storage")
    const migration = await Bun.file(path.join(dir, "migration"))
      .json()
      .then((x) => parseInt(x))
      .catch(() => 0)
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migration = MIGRATIONS[index]
      await migration(dir).catch(() => log.error("failed to run migration", { index }))
      await Bun.write(path.join(dir, "migration"), (index + 1).toString())
    }
    return {
      dir,
    }
  })

  export async function remove(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = await resolvePath(dir, key)
    return withErrorHandling(async () => {
      if (key[0] === "session" && key[1]) {
        const sessionID = key[2] ?? key[1]
        const sessionDir = path.dirname(target)
        await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => { })
        await fs.unlink(sessionIndexPath(dir, sessionID)).catch(() => { })

        // Cleanup legacy message directory if it exists
        const legacyMsgDir = path.join(dir, "message", sessionID)
        await fs.rm(legacyMsgDir, { recursive: true, force: true }).catch(() => { })

        // Best-effort cleanup of message indexes for this session
        const msgIndexDir = path.join(dir, ...MESSAGE_INDEX_DIR)
        const entries = await fs.readdir(msgIndexDir, { withFileTypes: true }).catch(() => [] as any[])
        await Promise.all(
          entries
            .filter((x) => x.isFile() && x.name.endsWith(".json"))
            .map(async (entry) => {
              const p = path.join(msgIndexDir, entry.name)
              const index = await readJSON<{ sessionID?: string }>(p)
              if (index?.sessionID === sessionID) await fs.unlink(p).catch(() => { })
            }),
        )
        return
      }

      if (key[0] === "message" && key[1] && key[2]) {
        await fs.rm(path.dirname(target), { recursive: true, force: true }).catch(() => { })
        await fs.unlink(messageIndexPath(dir, key[2])).catch(() => { })
        return
      }

      await fs.rm(target, { force: true }).catch(() => { })
    })
  }

  export async function read<T>(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = await resolvePath(dir, key)
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      const result = await Bun.file(target).json()
      return result as T
    })
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const dir = await state().then((x) => x.dir)
    const target = await resolvePath(dir, key)
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await Bun.file(target).json()
      fn(content)
      await Bun.write(target, JSON.stringify(content, null, 2))
      return content as T
    })
  }

  export async function write<T>(key: string[], content: T) {
    const dir = await state().then((x) => x.dir)
    const target = await resolvePath(dir, key)
    return withErrorHandling(async () => {
      await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => { })
      using _ = await Lock.write(target)
      await Bun.write(target, JSON.stringify(content, null, 2))

      // New format: ["session", sessionID]
      if (key[0] === "session" && key[1] && !key[2]) {
        const info = content as any
        if (info.projectID) {
          await upsertSessionIndex(dir, key[1], info.projectID, info.parentID)
        }
      }

      // Old format: ["session", projectID, sessionID] (backward compatibility)
      if (key[0] === "session" && key[1] && key[2]) {
        const info = content as any
        await upsertSessionIndex(dir, key[2], key[1], info?.parentID)
      }

      if (key[0] === "message" && key[1] && key[2]) {
        const projectID = await resolveSessionProjectID(dir, key[1])
        if (projectID) await upsertMessageIndex(dir, key[2], projectID, key[1])
      }
    })
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  const glob = new Bun.Glob("**/*")
  export async function list(prefix: string[]) {
    const dir = await state().then((x) => x.dir)
    try {
      if (prefix[0] === "session") {
        const ids = new Set<string>()

        // Optimization: Use index directory if it exists and has entries
        const indexRoot = path.join(dir, ...SESSION_INDEX_DIR)
        const indexEntries = await fs.readdir(indexRoot, { withFileTypes: true }).catch(() => [] as any[])

        if (indexEntries.length > 0) {
          const results = await Promise.all(
            indexEntries.map(async (entry) => {
              if (!entry.isFile() || !entry.name.endsWith(".json")) return null
              const id = path.basename(entry.name, ".json")
              if (prefix[1] || prefix[2]) {
                const indexed = await readJSON<{ projectID: string; parentID?: string }>(path.join(indexRoot, entry.name))
                if (prefix[1] && indexed?.projectID !== prefix[1]) return null
                if (prefix[2] && indexed?.parentID !== prefix[2]) return null
              }
              return id
            }),
          )
          for (const id of results) {
            if (id) ids.add(id)
          }
        } else {
          // Fallback to directory scanning
          const flatRoot = path.join(dir, "session")
          const flatEntries = await fs.readdir(flatRoot, { withFileTypes: true }).catch(() => [] as any[])

          const results = await Promise.all(
            flatEntries.map(async (entry) => {
              if (!entry.isDirectory()) return null
              const info = path.join(flatRoot, entry.name, "info.json")
              if (!(await Bun.file(info).exists())) return null

              if (prefix[1] || prefix[2]) {
                const sessionInfo = await readJSON<{ projectID?: string; parentID?: string }>(info)
                if (prefix[1] && sessionInfo?.projectID !== prefix[1]) return null
                if (prefix[2] && sessionInfo?.parentID !== prefix[2]) return null
              }
              return entry.name
            }),
          )
          for (const id of results) {
            if (id) ids.add(id)
          }
        }

        return Array.from(ids)
          .sort()
          .map((id) => (prefix[1] ? ["session", prefix[1], id] : ["session", id]))
      }

      if (prefix[0] === "message" && prefix[1]) {
        const sessionID = prefix[1]
        const ids = new Set<string>()

        const flatRoot = path.join(dir, "session", sessionID, "messages")
        const flatEntries = await fs.readdir(flatRoot, { withFileTypes: true }).catch(() => [] as any[])
        for (const entry of flatEntries) {
          if (!entry.isDirectory()) continue
          const info = path.join(flatRoot, entry.name, "info.json")
          if (await Bun.file(info).exists()) ids.add(entry.name)
        }

        return Array.from(ids)
          .sort()
          .map((id) => ["message", sessionID, id])
      }

      if (prefix[0] === "part" && prefix[1]) {
        const messageID = prefix[1]
        const scope = await resolveMessageScope(dir, messageID)
        const ids = new Set<string>()

        if (scope) {
          const flatRoot = path.join(dir, "session", scope.sessionID, "messages", messageID, "parts")
          const flatEntries = await fs.readdir(flatRoot, { withFileTypes: true }).catch(() => [] as any[])
          for (const entry of flatEntries) {
            if (entry.isFile() && entry.name.endsWith(".json")) ids.add(path.basename(entry.name, ".json"))
          }
        }

        return Array.from(ids)
          .sort()
          .map((id) => ["part", messageID, id])
      }

      const result = await Array.fromAsync(
        glob.scan({
          cwd: path.join(dir, ...prefix),
          onlyFiles: true,
        }),
      ).then((results) => results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]))
      result.sort()
      return result
    } catch {
      return []
    }
  }
}
