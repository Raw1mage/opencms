import fs from "fs/promises"
import path from "path"

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

export async function isDirectory(targetPath: string) {
  try {
    const stat = await fs.stat(targetPath)
    return stat.isDirectory()
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false
    }
    throw error
  }
}

function isPathInsideRoot(target: string, root: string) {
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep
  return target === root || target.startsWith(normalizedRoot)
}

export async function assertRealpathInsideRoot(targetPath: string, rootPath: string, label: string) {
  const [targetReal, rootReal] = await Promise.all([fs.realpath(targetPath), fs.realpath(rootPath)])
  if (!isPathInsideRoot(targetReal, rootReal)) {
    // FIX: prevent symlink/path escape for bundled skills install (@event_20260210_bundled_skills_guard)
    throw new Error(`${label} resolved outside allowed root: ${targetPath}`)
  }
}

export async function writeFileAtomically(targetPath: string, content: string) {
  const tempPath = `${targetPath}.tmp`
  await Bun.write(tempPath, content)
  await fs.rename(tempPath, targetPath)
}

export async function copyMissingTree(srcRoot: string, dstRoot: string) {
  await fs.mkdir(dstRoot, { recursive: true })
  const entries = await fs.readdir(srcRoot, { withFileTypes: true })
  for (const entry of entries) {
    const src = path.join(srcRoot, entry.name)
    const dst = path.join(dstRoot, entry.name)
    if (entry.isDirectory()) {
      await copyMissingTree(src, dst)
      continue
    }
    if (!entry.isFile()) continue
    const exists = await Bun.file(dst).exists()
    if (exists) continue
    await fs.mkdir(path.dirname(dst), { recursive: true }).catch(() => {})
    await Bun.write(dst, Bun.file(src))
  }
}

type InstallBundledSkillsOptions = {
  srcRoot: string
  dstRoot: string
  templatesRoot: string
  dataRoot: string
  version?: string
  copyTree?: (srcRoot: string, dstRoot: string) => Promise<void>
}

export async function installBundledSkills(options: InstallBundledSkillsOptions) {
  const { srcRoot, dstRoot, templatesRoot, dataRoot, version = "1", copyTree = copyMissingTree } = options

  // FIX: verify source and destination roots to avoid symlink escape (@event_20260210_bundled_skills_guard)
  await fs.mkdir(dstRoot, { recursive: true })
  await assertRealpathInsideRoot(srcRoot, templatesRoot, "Bundled skills source")
  await assertRealpathInsideRoot(dstRoot, dataRoot, "Bundled skills destination")

  // @event_2026-02-10_bundled_skills: avoid expensive tree walk on every startup.
  // Bump this version when bundled skills inventory changes.
  const bundledSkillsVersionFile = path.join(dstRoot, ".bundled-version")
  const installedVersion = await Bun.file(bundledSkillsVersionFile)
    .text()
    .then((text) => text.trim())
    .catch(() => "")

  if (installedVersion === version) {
    return false
  }

  // FIX: only update version marker after successful copy (@event_20260210_bundled_skills_marker)
  await copyTree(srcRoot, dstRoot)
  await writeFileAtomically(bundledSkillsVersionFile, version)
  return true
}
