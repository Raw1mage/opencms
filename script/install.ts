#!/usr/bin/env bun

import { Global } from "../packages/opencode/src/global"
import fs from "fs"
import os from "os"
import path from "path"
import { $ } from "bun"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..")
process.chdir(repoRoot)

const pkgPath = path.join(repoRoot, "package.json")
const pkgJson = await Bun.file(pkgPath).json()
const pkgName = pkgJson.name as string

// @event_2026-02-07_install: build + system install flow

const installDir = (() => {
  if (process.env.OPENCODE_INSTALL_DIR) {
    return path.resolve(process.env.OPENCODE_INSTALL_DIR)
  }

  // @event_2026-02-06_xdg-install: prioritize XDG_BIN_HOME or ~/.local/bin
  if (process.env.XDG_BIN_HOME) {
    return path.resolve(process.env.XDG_BIN_HOME)
  }

  if (process.env.XDG_BIN_DIR) {
    return path.resolve(process.env.XDG_BIN_DIR)
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? ""
    if (localAppData) {
      return path.resolve(localAppData, "bin")
    }
    return path.resolve(repoRoot, "bin")
  }

  return path.join(os.homedir(), ".local/bin")
})()

const binaryName = process.platform === "win32" ? "opencode.exe" : "opencode"
const osSegment = process.platform === "win32" ? "windows" : process.platform
const archMap: Record<string, string | undefined> = {
  x64: "x64",
  arm64: "arm64",
}
const archSegment = archMap[process.arch]

if (!archSegment) {
  throw new Error(`unsupported architecture: ${process.arch}`)
}

const targetName = `${pkgName}-${osSegment}-${archSegment}`
const builtBinaryPath = path.join(repoRoot, "dist", targetName, "bin", binaryName)

const ensureDir = (dir: string) => {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") {
      throw error
    }
  }
}

const fsPromises = fs.promises
const templatesDir = path.join(repoRoot, "templates")
const manifestPath = path.join(templatesDir, "manifest.json")
const TEMPLATE_SENSITIVE_FILES = new Set(["accounts.json", "mcp-auth.json"])
const LEGACY_OPENCODE_DIR = path.join(os.homedir(), ".opencode")

type TemplateTarget = "config" | "state" | "data"

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
    console.error("無法解析 templates/manifest.json", error)
  }
  return []
}

const movePath = async (src: string, dest: string) => {
  ensureDir(path.dirname(dest))
  try {
    await fsPromises.rename(src, dest)
    return
  } catch (error) {
    if ((error as { code?: string }).code !== "EXDEV") throw error
  }

  const stat = await fsPromises.lstat(src)
  if (stat.isDirectory()) {
    await fsPromises.cp(src, dest, { recursive: true })
    await fsPromises.rm(src, { recursive: true, force: true })
  } else {
    await fsPromises.copyFile(src, dest)
    await fsPromises.rm(src, { force: true })
  }
}

// @event_2026-02-07_install: REMOVED cleanupToCyclebin
// 原設計缺陷：使用白名單策略，只保護 manifest 中的檔案，其餘一律移除
// 但 manifest 只有 8 個模板檔案，而 runtime 會產生 20+ 種檔案
// 導致使用者的認證憑證、session 歷史、模型狀態等核心資料被誤刪
//
// 若未來需要清理功能，應：
// 1. 獨立成 `bun run cleanup` 指令
// 2. 使用黑名單策略（只移除明確已知的過時檔案如 .tmp, .bak-*）
// 3. 預設 dry-run 模式，需要 --force 才會實際執行
// 4. 互動確認，列出將被移動的檔案讓使用者確認

type TemplateManifestEntry = {
  path: string
  description?: string
  sensitive?: boolean
  target?: TemplateTarget
}

const migrateLegacyOpencode = async (entries: TemplateManifestEntry[]) => {
  // @event_2026-02-07_install: migrate legacy ~/.opencode to XDG
  if (!fs.existsSync(LEGACY_OPENCODE_DIR)) return

  const legacyRuntimeDirs = [
    { name: "generated-images", dest: path.join(Global.Path.data, "generated-images") },
    { name: "logs", dest: Global.Path.log },
    { name: "node_modules", dest: path.join(Global.Path.data, "node_modules") },
    { name: "cyclebin", dest: path.join(Global.Path.state, "cyclebin", "legacy-import") },
  ]

  const legacyFiles = [
    {
      name: "openai-codex-accounts.json",
      dest: path.join(Global.Path.config, "openai-codex-accounts.json"),
      sensitive: true,
    },
    {
      name: "openai-codex-auth-config.json",
      dest: path.join(Global.Path.config, "openai-codex-auth-config.json"),
      sensitive: true,
    },
    {
      name: "model-status.json",
      dest: path.join(Global.Path.state, "model-status.json"),
    },
  ]

  for (const entry of entries) {
    const src = path.join(LEGACY_OPENCODE_DIR, entry.path)
    if (!fs.existsSync(src)) continue
    const destRoot = resolveTargetDir(entry.target ?? "config")
    const dest = path.join(destRoot, entry.path)

    // @event_2026-02-07_install: improved migration logic
    // Overwrite if target is missing, empty, or a small default template
    // especially for files like AGENTS.md where user content is likely larger.
    const destExists = fs.existsSync(dest)
    if (destExists) {
      const srcStat = await fsPromises.stat(src)
      const destStat = await fsPromises.stat(dest)
      if (destStat.size >= srcStat.size && destStat.size > 100) {
        continue
      }
      console.log(`正在用較大的 legacy 檔案覆蓋 XDG 預設檔: ${entry.path}`)
    }

    try {
      await movePath(src, dest)
      if (entry.sensitive || TEMPLATE_SENSITIVE_FILES.has(path.basename(entry.path))) {
        await fsPromises.chmod(dest, 0o600).catch(() => {})
      }
      console.log(`已搬遷 legacy 設定 ${entry.path} 到 ${dest}`)
    } catch (error) {
      console.warn(`無法搬遷 legacy 設定 ${entry.path}:`, error)
    }
  }

  for (const legacy of legacyRuntimeDirs) {
    const src = path.join(LEGACY_OPENCODE_DIR, legacy.name)
    if (!fs.existsSync(src)) continue
    if (fs.existsSync(legacy.dest)) continue
    try {
      await movePath(src, legacy.dest)
      console.log(`已搬遷 legacy 資產 ${legacy.name} 到 ${legacy.dest}`)
    } catch (error) {
      console.warn(`無法搬遷 legacy 資產 ${legacy.name}:`, error)
    }
  }

  for (const legacy of legacyFiles) {
    const src = path.join(LEGACY_OPENCODE_DIR, legacy.name)
    if (!fs.existsSync(src)) continue
    if (fs.existsSync(legacy.dest)) continue
    try {
      await movePath(src, legacy.dest)
      if (legacy.sensitive) await fsPromises.chmod(legacy.dest, 0o600).catch(() => {})
      console.log(`已搬遷 legacy 檔案 ${legacy.name} 到 ${legacy.dest}`)
    } catch (error) {
      console.warn(`無法搬遷 legacy 檔案 ${legacy.name}:`, error)
    }
  }

  const remaining = await fsPromises.readdir(LEGACY_OPENCODE_DIR, { withFileTypes: true })
  if (remaining.length === 0) {
    await fsPromises.rmdir(LEGACY_OPENCODE_DIR).catch(() => {})
    return
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const legacyBin = path.join(Global.Path.state, "cyclebin", timestamp, "legacy-opencode")
  ensureDir(legacyBin)

  for (const entry of remaining) {
    const src = path.join(LEGACY_OPENCODE_DIR, entry.name)
    const dest = path.join(legacyBin, entry.name)
    try {
      await movePath(src, dest)
      console.log(`已封存 legacy 項目 ${entry.name} 到 ${legacyBin}`)
    } catch (error) {
      console.warn(`無法封存 legacy 項目 ${entry.name}:`, error)
    }
  }

  await fsPromises.rmdir(LEGACY_OPENCODE_DIR).catch(() => {})
}

const installTemplates = async (entries: TemplateManifestEntry[]) => {
  // @event_2026-02-07_install: template manifest-driven initialization (XDG targets)
  // @event_2026-02-07_sync: date-based sync for non-sensitive files, backup before overwrite
  if (entries.length === 0) return

  for (const entry of entries) {
    const relativePath = entry.path
    const src = path.join(templatesDir, relativePath)
    const targetRoot = resolveTargetDir(entry.target ?? "config")
    const dest = path.join(targetRoot, relativePath)
    if (!(await Bun.file(src).exists())) continue

    const isSensitive = entry.sensitive || TEMPLATE_SENSITIVE_FILES.has(path.basename(relativePath))
    const destExists = await Bun.file(dest).exists()

    if (destExists) {
      // 敏感檔案：永不覆蓋
      if (isSensitive) continue

      // 非敏感檔案：比較 mtime，源較新才覆蓋
      const srcStat = await fsPromises.stat(src)
      const destStat = await fsPromises.stat(dest)
      if (srcStat.mtime <= destStat.mtime) continue

      // 覆蓋前備份
      const backupPath = dest + ".bak"
      await fsPromises.copyFile(dest, backupPath)
      console.log(`已備份 ${relativePath} 到 ${backupPath}`)
    }

    ensureDir(path.dirname(dest))
    await Bun.write(dest, Bun.file(src))
    if (isSensitive) {
      await fsPromises.chmod(dest, 0o600)
    }
    console.log(`${destExists ? "已更新" : "初始化"}設定檔 ${relativePath} 到 ${dest}`)
  }
}

const runBuild = async () => {
  console.log("正在執行 bun run build --single --skip-install")
  await $`bun run build --single --skip-install`
}

// @event_2026-02-07_terminal-cleanup: Install shell profile for terminal protection
const installShellProfile = async () => {
  const shellProfileSrc = path.join(templatesDir, "shell-profile.sh")
  if (!(await Bun.file(shellProfileSrc).exists())) return

  const profileContent = await Bun.file(shellProfileSrc).text()
  const marker = "# OpenCode Terminal Protection"

  // Detect user's shell and profile file
  const shell = process.env.SHELL || "/bin/bash"
  const homeDir = os.homedir()
  const profilePaths = shell.includes("zsh")
    ? [path.join(homeDir, ".zshrc")]
    : [path.join(homeDir, ".bashrc"), path.join(homeDir, ".bash_profile")]

  for (const profilePath of profilePaths) {
    if (!fs.existsSync(profilePath)) continue

    const existing = await Bun.file(profilePath).text()
    if (existing.includes(marker)) {
      console.log(`Shell profile 已存在於 ${profilePath}`)
      return
    }

    // Append to profile
    await fsPromises.appendFile(profilePath, "\n" + profileContent + "\n")
    console.log(`已安裝 terminal protection 到 ${profilePath}`)
    console.log("請執行 source " + profilePath + " 或重新開啟終端機以生效")
    return
  }
}

const installBinary = () => {
  if (!fs.existsSync(builtBinaryPath)) {
    throw new Error(`找不到建置輸出: ${builtBinaryPath}`)
  }

  ensureDir(installDir)

  const destination = path.join(installDir, binaryName)
  console.log(`將 ${path.basename(builtBinaryPath)} 安裝到 ${destination}`)

  try {
    // 先刪除目標檔案以避免 ETXTBSY（binary 正在執行時無法覆寫，但可以刪除）
    if (fs.existsSync(destination)) {
      fs.unlinkSync(destination)
    }
    fs.copyFileSync(builtBinaryPath, destination)
    fs.chmodSync(destination, 0o755)
  } catch (error) {
    if ((error as { code?: string }).code === "EACCES") {
      throw new Error(`權限不足，請使用具有寫入 ${installDir} 權限的帳號（例如 sudo）重新執行 bun run install`)
    }
    throw error
  }
  console.log("安裝完成")
}

try {
  const entries = await loadManifestEntries()
  await runBuild()
  installBinary()
  await migrateLegacyOpencode(entries)
  // cleanupToCyclebin 已移除：install 不應清理使用者資料
  await installTemplates(entries)
  await installShellProfile()
} catch (error) {
  console.error("安裝失敗:", error)
  process.exit(1)
}
