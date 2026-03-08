import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { Global } from "../packages/opencode/src/global"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..")
const templatesDir = path.join(repoRoot, "templates")
const manifestPath = path.join(templatesDir, "manifest.json")
const TEMPLATE_SENSITIVE_FILES = new Set(["accounts.json", "mcp-auth.json"])

type TemplateTarget = "config" | "state" | "data"

type TemplateManifestEntry = {
  path: string
  description?: string
  sensitive?: boolean
  target?: TemplateTarget
}

function resolveTargetDir(target?: TemplateTarget) {
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

async function loadManifestEntries(): Promise<TemplateManifestEntry[]> {
  if (!(await Bun.file(manifestPath).exists())) return []
  try {
    const manifest = JSON.parse(await Bun.file(manifestPath).text())
    if (Array.isArray(manifest.entries)) return manifest.entries
    if (Array.isArray(manifest)) return manifest
  } catch (error) {
    console.warn("[runtime-init-check] failed to parse templates/manifest.json", error)
  }
  return []
}

async function ensureDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true })
}

async function ensureRuntimeSkeleton() {
  await ensureDir(Global.Path.config)
  await ensureDir(Global.Path.data)
  await ensureDir(Global.Path.state)
  await ensureDir(Global.Path.cache)
}

async function installMissingTemplates(entries: TemplateManifestEntry[]) {
  for (const entry of entries) {
    const src = path.join(templatesDir, entry.path)
    if (!(await Bun.file(src).exists())) continue
    const destRoot = resolveTargetDir(entry.target ?? "config")
    const dest = path.join(destRoot, entry.path)
    if (await Bun.file(dest).exists()) continue
    await ensureDir(path.dirname(dest))
    await Bun.write(dest, Bun.file(src))
    const isSensitive = entry.sensitive || TEMPLATE_SENSITIVE_FILES.has(path.basename(entry.path))
    if (isSensitive) await fs.promises.chmod(dest, 0o600).catch(() => undefined)
    console.log(`[runtime-init-check] seeded ${entry.target ?? "config"}:${entry.path}`)
  }
}

async function main() {
  process.chdir(repoRoot)
  await ensureRuntimeSkeleton()
  const entries = await loadManifestEntries()
  await installMissingTemplates(entries)

  const summary = {
    user: os.userInfo().username,
    config: Global.Path.config,
    data: Global.Path.data,
    state: Global.Path.state,
    cache: Global.Path.cache,
  }
  console.log(`[runtime-init-check] ready for ${summary.user}`)
}

await main()
