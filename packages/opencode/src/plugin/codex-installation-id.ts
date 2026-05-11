import fs from "fs/promises"
import path from "path"
import crypto from "crypto"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "codex-installation-id" })

const FILENAME = "codex-installation-id"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export class CodexInstallationIdResolveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "CodexInstallationIdResolveError"
  }
}

let cached: string | undefined
let pathOverride: string | undefined

function targetPath(): string {
  return pathOverride ?? path.join(Global.Path.config, FILENAME)
}

async function readExisting(filePath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    const trimmed = raw.trim().toLowerCase()
    return UUID_RE.test(trimmed) ? trimmed : undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

async function createExclusive(filePath: string, uuid: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(filePath, "wx", 0o644)
    await handle.writeFile(uuid)
    await handle.sync()
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
    throw err
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function rewriteCorrupted(filePath: string, uuid: string): Promise<void> {
  await fs.writeFile(filePath, uuid, { mode: 0o644 })
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(filePath, "r+")
    await handle.sync()
  } finally {
    await handle?.close().catch(() => {})
  }
  await fs.chmod(filePath, 0o644).catch(() => {})
}

export async function resolveCodexInstallationId(): Promise<string> {
  if (cached) return cached
  const filePath = targetPath()
  try {
    const existing = await readExisting(filePath)
    if (existing) {
      cached = existing
      log.info("resolved", { source: "existing" })
      return cached
    }

    const fresh = crypto.randomUUID()
    const won = await createExclusive(filePath, fresh)
    if (won) {
      cached = fresh
      log.info("resolved", { source: "generated" })
      return cached
    }

    const afterRace = await readExisting(filePath)
    if (afterRace) {
      cached = afterRace
      log.info("resolved", { source: "existing", note: "lost concurrent race" })
      return cached
    }

    await rewriteCorrupted(filePath, fresh)
    cached = fresh
    log.info("resolved", { source: "rewritten", reason: "post-race contents invalid" })
    return cached
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code
    log.error("resolve_failed", { errno, path: filePath })
    throw new CodexInstallationIdResolveError(
      `failed to resolve codex installation id at ${filePath}: ${errno ?? "unknown"}`,
      { cause: err },
    )
  }
}

export function _resetForTesting(opts?: { path?: string }): void {
  cached = undefined
  pathOverride = opts?.path
}
