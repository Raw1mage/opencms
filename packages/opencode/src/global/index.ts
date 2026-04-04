import fs from "fs/promises"
import fsSync, { constants as fsConstants } from "fs"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"
import { isDirectory, installBundledSkills } from "./bundled-skills"
// FIX: Use process.env directly to avoid circular dependency
// Env → Instance → Log → debug.ts → Global → Env (@event_20260209_circular_dep)

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
    /** ~/.config/opencode/ — primary configuration (XDG standard) */
    get user() {
      return this.config
    },
    data: resolvedPaths.data,
    bin: path.join(resolvedPaths.data, "bin"),
    frontend: path.join(resolvedPaths.data, "frontend"),
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

// @event_2026-02-07_install: install template files by XDG target
type TemplateTarget = "config" | "state" | "data"
type TemplateManifestEntry = {
  path: string
  sensitive?: boolean
  target?: TemplateTarget
}

const SENSITIVE_FILES = new Set(["accounts.json", "mcp-auth.json"])
const getTemplatesDir = () => {
  if (process.env.OPENCODE_TEMPLATES_DIR) return process.env.OPENCODE_TEMPLATES_DIR
  
  // 1. Check relative to current working directory (Dev mode)
  const devPath = path.join(process.cwd(), "templates")
  if (path.basename(process.cwd()) === "opencode" || path.basename(process.cwd()) === "opencode-data") {
    // Basic heuristic to avoid false positives in random dirs
    if (fsSync.existsSync(path.join(devPath, "manifest.json"))) return devPath
  }

  // 2. Check relative to source (Repo mode)
  const repoPath = path.join(import.meta.dir, "../../../../templates")

  // 3. System-wide fallback (Operation mode - independent of repo)
  const systemPath = "/usr/local/share/opencode/templates"

  // Heuristic check: check for manifest.json
  if (fsSync.existsSync(path.join(repoPath, "manifest.json"))) return repoPath
  if (fsSync.existsSync(path.join(systemPath, "manifest.json"))) return systemPath
  
  // In compiled binary mode, bunfs repo paths are invalid — prefer system path.
  // In dev mode, repo path is valid even without manifest.json.
  const isCompiledBinary = import.meta.url.includes("/$bunfs/")
  if (isCompiledBinary) {
    console.warn(`[templates] no manifest.json found at system path ${systemPath}, using it anyway (compiled binary mode)`)
    return systemPath
  }
  return repoPath
}

const templatesDir = getTemplatesDir()

const manifestPath = path.join(templatesDir, "manifest.json")

const resolveTargetDir = (target?: TemplateTarget) => {
  switch (target) {
    case "state":
      return Global.Path.state
    case "data":
      return Global.Path.data
    case "config":
    default:
      return Global.Path.config
  }
}

const loadManifestEntries = async (): Promise<TemplateManifestEntry[]> => {
  const manifestExists = await Bun.file(manifestPath).exists()
  if (!manifestExists) return []
  try {
    const manifest = JSON.parse(await Bun.file(manifestPath).text())
    if (Array.isArray(manifest.entries)) return manifest.entries
    if (Array.isArray(manifest)) return manifest
  } catch (error) {
    console.warn("無法解析 templates/manifest.json", error)
  }
  return []
}

const fallbackEntries: TemplateManifestEntry[] = [
  { path: "accounts.json", sensitive: true, target: "config" },
  { path: "ignored-models.json", target: "state" },
  { path: "mcp-auth.json", sensitive: true, target: "config" },
  { path: "package.json", target: "data" },
  { path: ".gitignore", target: "data" },
  { path: "AGENTS.md", target: "config" },
  { path: "opencode.json", target: "config" },
  { path: "CONFIG-README.md", target: "config" },
]

const manifestEntries = await loadManifestEntries()
const templateEntries = manifestEntries.length > 0 ? manifestEntries : fallbackEntries

await Promise.all(
  templateEntries.map(async (entry) => {
    const targetRoot = resolveTargetDir(entry.target ?? "config")
    const target = path.join(targetRoot, entry.path)
    const file = Bun.file(target)
    const exists = await file.exists()

    // @event_2026-02-07_install: only install template if target missing or trivial/empty
    // This prevents templates from blocking migration of larger legacy files.
    if (exists && (await file.size) > 100) return

    const src = path.join(templatesDir, entry.path)
    const srcExists = await Bun.file(src).exists()
    if (!srcExists) return

    // If legacy file exists and is significantly larger than template, skip template
    // and let specific modules or install script handle the migration.
    const legacyPath = path.join(os.homedir(), ".opencode", entry.path)
    if (await Bun.file(legacyPath).exists()) {
      const legacySize = await Bun.file(legacyPath).size
      const templateSize = await Bun.file(src).size
      if (legacySize > templateSize + 100) {
        return
      }
    }

    await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => {})
    await Bun.write(target, Bun.file(src))
    if (entry.sensitive || SENSITIVE_FILES.has(entry.path)) await fs.chmod(target, 0o600)
  }),
)

// @event_2026-02-10_bundled_skills: Install bundled skills into XDG data dir.
// Runtime should load skills from managed data paths, not directly from repository templates.
if (process.env.NODE_ENV !== "test") {
  const bundledSkillsSrc = path.join(templatesDir, "skills")
  const bundledSkillsDst = path.join(Global.Path.data, "skills")
  const srcExists = await isDirectory(bundledSkillsSrc)
  if (srcExists) {
    await installBundledSkills({
      srcRoot: bundledSkillsSrc,
      dstRoot: bundledSkillsDst,
      templatesRoot: templatesDir,
      dataRoot: Global.Path.data,
      version: "2",
    })
  }
}

// @event_2026-03-31_user-init: Auto-install shell profile for new users
const installUserShellProfile = async () => {
  const shellProfileSrc = path.join(templatesDir, "shell-profile.sh")
  if (!(await Bun.file(shellProfileSrc).exists())) return

  const marker = "# OpenCode Terminal Protection"
  const homeDir = os.homedir()
  const bashrcPath = path.join(homeDir, ".bashrc")
  
  if (!(await Bun.file(bashrcPath).exists())) return

  try {
    const content = await Bun.file(bashrcPath).text()
    if (content.includes(marker)) return

    const profileContent = await Bun.file(shellProfileSrc).text()
    await fs.appendFile(bashrcPath, "\n" + profileContent + "\n")
    console.log(`[user-init] 已安裝 terminal protection 到 ${bashrcPath}`)
  } catch (error) {
    console.warn("[user-init] 無法更新 .bashrc", error)
  }
}

if (process.env.OPENCODE_USER_DAEMON_MODE === "1") {
  await installUserShellProfile()
}

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
  } catch (e) {
    console.warn("Failed to clear cache during version migration", e)
  }
  await Bun.file(path.join(Global.Path.cache, "version")).write(CACHE_VERSION)
}

// @event_2026-02-09_path_cleanup: Detect and warn about legacy .opencode directory
if (os.platform() !== "win32") {
  const legacyDir = path.join(os.homedir(), ".opencode")
  const exists = await fs
    .access(legacyDir)
    .then(() => true)
    .catch(() => false)
  if (exists) {
    console.warn("\n[WARNING] 偵測到遺留目錄: " + legacyDir)
    console.warn("這可能會導致路徑衝突或 Session 偏移。")
    console.warn("建議執行 `bun run install` 以完成遷移，或手動刪除該目錄。\n")
  }
}
