import fs from "fs/promises"
import { constants as fsConstants } from "fs"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"

const app = "opencode"

type DirectorySet = {
  data: string
  cache: string
  config: string
  state: string
}

const defaultPaths: DirectorySet = {
  data: path.join(xdgData ?? path.join(os.homedir(), ".local/share"), app),
  cache: path.join(xdgCache ?? path.join(os.homedir(), ".cache"), app),
  config: path.join(xdgConfig ?? path.join(os.homedir(), ".config"), app),
  state: path.join(xdgState ?? path.join(os.homedir(), ".local/state"), app),
}

const fallbackRoot = process.env.OPENCODE_DATA_HOME ?? path.join(process.cwd(), ".opencode-data")
const fallbackPaths: DirectorySet = {
  data: path.join(fallbackRoot, "data"),
  cache: path.join(fallbackRoot, "cache"),
  config: path.join(fallbackRoot, "config"),
  state: path.join(fallbackRoot, "state"),
}

async function ensurePaths(paths: DirectorySet) {
  await Promise.all(
    Object.values(paths).map(async (dir) => {
      await fs.mkdir(dir, { recursive: true })
      await fs.access(dir, fsConstants.W_OK)
    }),
  )
}

function isAccessDenied(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === "EACCES" || code === "EPERM"
}

const resolvedPaths: DirectorySet = await (async () => {
  try {
    await ensurePaths(defaultPaths)
    return defaultPaths
  } catch (error) {
    if (isAccessDenied(error)) {
      await fs.mkdir(fallbackRoot, { recursive: true }).catch(() => {})
      await ensurePaths(fallbackPaths)
      return fallbackPaths
    }
    throw error
  }
})()

export namespace Global {
  export const Path = {
    // Allow override via OPENCODE_TEST_HOME for test isolation
    get home() {
      return process.env.OPENCODE_TEST_HOME || os.homedir()
    },
    /** ~/.opencode/ — user-specific data (accounts, logs, ignored-models, etc.) */
    get user() {
      return path.join(this.home, ".opencode")
    },
    data: resolvedPaths.data,
    bin: path.join(resolvedPaths.data, "bin"),
    log: path.join(resolvedPaths.data, "log"),
    cache: resolvedPaths.cache,
    config: resolvedPaths.config,
    state: resolvedPaths.state,
  }
}

await Promise.all([
  fs.mkdir(Global.Path.user, { recursive: true }),
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
])

// Install template user-data files to ~/.opencode/ if they don't exist yet
const SENSITIVE_FILES = new Set(["accounts.json", "openai-codex-accounts.json", "mcp-auth.json"])
const templateFiles = [
  "accounts.json",
  "ignored-models.json",
  "mcp-auth.json",
  "model-status.json",
  "openai-codex-accounts.json",
  "openai-codex-auth-config.json",
  "package.json",
  ".gitignore",
  "AGENTS.md",
  "local-config/opencode.json",
  "local-config/README.md",
]
const templatesDir = path.join(import.meta.dir, "../../templates")
await Promise.all(
  templateFiles.map(async (name) => {
    const target = path.join(Global.Path.user, name)
    const exists = await Bun.file(target).exists()
    if (exists) return
    const src = path.join(templatesDir, name)
    const srcExists = await Bun.file(src).exists()
    if (!srcExists) return
    await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => {})
    await Bun.write(target, Bun.file(src))
    if (SENSITIVE_FILES.has(name)) await fs.chmod(target, 0o600)
  }),
)

const CACHE_VERSION = "21"

const version = await Bun.file(path.join(Global.Path.cache, "version"))
  .text()
  .catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Global.Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Global.Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Bun.file(path.join(Global.Path.cache, "version")).write(CACHE_VERSION)
}
