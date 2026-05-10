import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { $ } from "bun"
import type { BunFile } from "bun"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import fs from "fs"
import ignore from "ignore"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Ripgrep } from "./ripgrep"
import fuzzysort from "fuzzysort"
import { Global } from "../global"
import { git } from "../util/git"

export namespace File {
  const log = Log.create({ service: "file" })

  export const Info = z
    .object({
      path: z.string(),
      added: z.number().int(),
      removed: z.number().int(),
      status: z.enum(["added", "deleted", "modified"]),
      before: z.string().optional(),
      after: z.string().optional(),
    })
    .meta({
      ref: "File",
    })

  export type Info = z.infer<typeof Info>

  export const Node = z
    .object({
      name: z.string(),
      path: z.string(),
      absolute: z.string(),
      type: z.enum(["file", "directory"]),
      ignored: z.boolean(),
      // Size in bytes for files. Omitted for directories — we do not
      // recursively aggregate directory sizes in V1.
      size: z.number().int().min(0).optional(),
      // Modification time in epoch milliseconds. Omitted when stat fails
      // (e.g. permission denied, transient race) so the UI can render the
      // name immediately and skip the column for that row.
      modifiedAt: z.number().optional(),
    })
    .meta({
      ref: "FileNode",
    })
  export type Node = z.infer<typeof Node>

  export const DirectoryCreateResult = z
    .object({
      name: z.string(),
      path: z.string(),
      absolute: z.string(),
      type: z.literal("directory"),
      ignored: z.boolean(),
    })
    .meta({
      ref: "FileDirectoryCreateResult",
    })
  export type DirectoryCreateResult = z.infer<typeof DirectoryCreateResult>

  export const OperationCode = z.enum([
    "FILE_OP_PATH_ESCAPE",
    "FILE_OP_INVALID_NAME",
    "FILE_OP_DUPLICATE",
    "FILE_OP_TARGET_NOT_DIRECTORY",
    "FILE_OP_SOURCE_NOT_FOUND",
    "FILE_OP_CONFIRMATION_REQUIRED",
    "FILE_OP_PERMISSION_DENIED",
    "FILE_OP_DESTINATION_AMBIGUOUS",
    "FILE_OP_PREFLIGHT_REQUIRED",
    "FILE_OP_NOT_FILE",
    "FILE_RECYCLEBIN_RESTORE_CONFLICT",
    "FILE_RECYCLEBIN_METADATA_INVALID",
    "FILE_DOWNLOAD_DIRECTORY_UNSUPPORTED",
    "FILE_UPLOAD_TOO_LARGE",
  ])
  export type OperationCode = z.infer<typeof OperationCode>

  export class OperationError extends Error {
    constructor(
      readonly code: OperationCode,
      message: string,
      readonly status = 400,
      readonly data?: Record<string, unknown>,
    ) {
      super(message)
      this.name = "FileOperationError"
    }

    toObject() {
      return {
        code: this.code,
        message: this.message,
        data: this.data,
      }
    }
  }

  export const OperationResult = z
    .object({
      operation: z.enum([
        "create-file",
        "create-directory",
        "rename",
        "move",
        "copy",
        "delete-to-recyclebin",
        "restore-from-recyclebin",
        "upload",
      ]),
      source: z.string().optional(),
      destination: z.string().optional(),
      node: Node.optional(),
      affectedDirectories: z.array(z.string()),
    })
    .meta({
      ref: "FileOperationResult",
    })
  export type OperationResult = z.infer<typeof OperationResult>

  export const DestinationPreflightResult = z
    .object({
      canonicalPath: z.string(),
      writable: z.boolean(),
      reason: OperationCode.optional(),
    })
    .meta({
      ref: "FileDestinationPreflightResult",
    })
  export type DestinationPreflightResult = z.infer<typeof DestinationPreflightResult>

  export const Content = z
    .object({
      type: z.enum(["text", "binary"]),
      content: z.string(),
      diff: z.string().optional(),
      patch: z
        .object({
          oldFileName: z.string(),
          newFileName: z.string(),
          oldHeader: z.string().optional(),
          newHeader: z.string().optional(),
          hunks: z.array(
            z.object({
              oldStart: z.number(),
              oldLines: z.number(),
              newStart: z.number(),
              newLines: z.number(),
              lines: z.array(z.string()),
            }),
          ),
          index: z.string().optional(),
        })
        .optional(),
      encoding: z.literal("base64").optional(),
      mimeType: z.string().optional(),
    })
    .meta({
      ref: "FileContent",
    })
  export type Content = z.infer<typeof Content>

  const binaryExtensions = new Set([
    "exe",
    "dll",
    "pdb",
    "bin",
    "so",
    "dylib",
    "o",
    "a",
    "lib",
    "wav",
    "mp3",
    "ogg",
    "oga",
    "ogv",
    "ogx",
    "flac",
    "aac",
    "wma",
    "m4a",
    "weba",
    "mp4",
    "avi",
    "mov",
    "wmv",
    "flv",
    "webm",
    "mkv",
    "zip",
    "tar",
    "gz",
    "gzip",
    "bz",
    "bz2",
    "bzip",
    "bzip2",
    "7z",
    "rar",
    "xz",
    "lz",
    "z",
    "pdf",
    "doc",
    "docx",
    "ppt",
    "pptx",
    "xls",
    "xlsx",
    "dmg",
    "iso",
    "img",
    "vmdk",
    "ttf",
    "otf",
    "woff",
    "woff2",
    "eot",
    "sqlite",
    "db",
    "mdb",
    "apk",
    "ipa",
    "aab",
    "xapk",
    "app",
    "pkg",
    "deb",
    "rpm",
    "snap",
    "flatpak",
    "appimage",
    "msi",
    "msp",
    "jar",
    "war",
    "ear",
    "class",
    "kotlin_module",
    "dex",
    "vdex",
    "odex",
    "oat",
    "art",
    "wasm",
    "wat",
    "bc",
    "ll",
    "s",
    "ko",
    "sys",
    "drv",
    "efi",
    "rom",
    "com",
    "bat",
    "cmd",
    "ps1",
    "sh",
    "bash",
    "zsh",
    "fish",
  ])

  const imageExtensions = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "bmp",
    "webp",
    "ico",
    "tif",
    "tiff",
    "svg",
    "svgz",
    "avif",
    "apng",
    "jxl",
    "heic",
    "heif",
    "raw",
    "cr2",
    "nef",
    "arw",
    "dng",
    "orf",
    "raf",
    "pef",
    "x3f",
  ])

  const textExtensions = new Set([
    "ts",
    "tsx",
    "mts",
    "cts",
    "mtsx",
    "ctsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "psm1",
    "cmd",
    "bat",
    "json",
    "jsonc",
    "json5",
    "yaml",
    "yml",
    "toml",
    "md",
    "mdx",
    "txt",
    "xml",
    "html",
    "htm",
    "css",
    "scss",
    "sass",
    "less",
    "graphql",
    "gql",
    "sql",
    "ini",
    "cfg",
    "conf",
    "env",
  ])

  const textNames = new Set([
    "dockerfile",
    "makefile",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".npmrc",
    ".nvmrc",
    ".prettierrc",
    ".eslintrc",
  ])

  function isImageByExtension(filepath: string): boolean {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    return imageExtensions.has(ext)
  }

  function isTextByExtension(filepath: string): boolean {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    return textExtensions.has(ext)
  }

  function isTextByName(filepath: string): boolean {
    const name = path.basename(filepath).toLowerCase()
    return textNames.has(name)
  }

  function getImageMimeType(filepath: string): string {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    const mimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      bmp: "image/bmp",
      webp: "image/webp",
      ico: "image/x-icon",
      tif: "image/tiff",
      tiff: "image/tiff",
      svg: "image/svg+xml",
      svgz: "image/svg+xml",
      avif: "image/avif",
      apng: "image/apng",
      jxl: "image/jxl",
      heic: "image/heic",
      heif: "image/heif",
    }
    return mimeTypes[ext] || "image/" + ext
  }

  function isBinaryByExtension(filepath: string): boolean {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    return binaryExtensions.has(ext)
  }

  function isImage(mimeType: string): boolean {
    return mimeType.startsWith("image/")
  }

  let projectRootRealCache: { directory: string; root: string } | undefined

  function allowGlobalFilesystemBrowse() {
    const flag = Bun.env.OPENCODE_ALLOW_GLOBAL_FS_BROWSE
    if (flag !== "1" && flag !== "true") return false
    return true
  }

  // -----------------------------------------------------------------------
  // Per-user filesystem access whitelist.
  //
  // File: ~/.config/opencode/file-access-whitelist.json (override via
  //       OPENCODE_FILE_ACCESS_WHITELIST_PATH env var for tests).
  // Shape: { "allow": ["/abs/path", ...] }
  //
  // When a path falls under any whitelist entry it bypasses the active-
  // project boundary check for BOTH list/read AND mutations. Realpath of
  // the candidate must also fall under the whitelist; this prevents a
  // symlink inside a whitelist root from escaping back outside.
  //
  // Loaded once and cached. Restart the daemon to pick up changes (same
  // policy as tweaks.cfg).
  let accessWhitelistCache: { path: string; entries: string[] } | undefined
  function loadAccessWhitelist(): string[] {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const customPath = process.env.OPENCODE_FILE_ACCESS_WHITELIST_PATH
    const filepath = customPath || (home ? path.join(home, ".config", "opencode", "file-access-whitelist.json") : "")
    // Cache keyed on resolved filepath so flipping the env var (test
    // isolation) or pointing at a fresh file invalidates automatically.
    if (accessWhitelistCache?.path === filepath) return accessWhitelistCache.entries
    if (!filepath) {
      accessWhitelistCache = { path: filepath, entries: [] }
      return accessWhitelistCache.entries
    }
    try {
      const raw = fs.readFileSync(filepath, "utf-8")
      const data = JSON.parse(raw) as unknown
      const allow = (data as { allow?: unknown })?.allow
      if (!Array.isArray(allow)) {
        log.warn("file-access-whitelist: 'allow' is not an array; ignoring", { filepath })
        accessWhitelistCache = { path: filepath, entries: [] }
        return accessWhitelistCache.entries
      }
      const parsed: string[] = []
      for (const entry of allow) {
        if (typeof entry !== "string") continue
        if (!path.isAbsolute(entry)) {
          log.warn("file-access-whitelist: entry not absolute, ignoring", { entry, filepath })
          continue
        }
        const normalized = entry.replace(/[\\/]+$/, "") || entry
        parsed.push(normalized)
      }
      accessWhitelistCache = { path: filepath, entries: parsed }
      if (parsed.length > 0) log.info("file-access-whitelist loaded", { count: parsed.length, entries: parsed })
      return accessWhitelistCache.entries
    } catch (err: unknown) {
      const errno = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined
      if (errno !== "ENOENT") {
        log.warn("file-access-whitelist: load failed", { filepath, error: String(err) })
      }
      accessWhitelistCache = { path: filepath, entries: [] }
      return accessWhitelistCache.entries
    }
  }

  function isInAccessWhitelist(candidate: string): boolean {
    const list = loadAccessWhitelist()
    for (const allowed of list) {
      if (isWithinRoot(candidate, allowed)) return true
    }
    return false
  }

  async function getProjectRootReal(): Promise<string> {
    const directory = Instance.directory
    const cacheKey = `${directory}:${allowGlobalFilesystemBrowse() ? "globalfs" : "project"}`
    if (projectRootRealCache?.directory === cacheKey) return projectRootRealCache.root

    if (allowGlobalFilesystemBrowse()) {
      const root = path.parse(directory).root || "/"
      projectRootRealCache = { directory: cacheKey, root }
      return root
    }

    let root: string
    try {
      root = await fs.promises.realpath(directory)
    } catch {
      root = directory
    }

    projectRootRealCache = { directory: cacheKey, root }
    return root
  }

  async function getStrictProjectRootReal(): Promise<string> {
    try {
      return await fs.promises.realpath(Instance.directory)
    } catch {
      return path.resolve(Instance.directory)
    }
  }

  function isWithinRoot(candidate: string, root: string): boolean {
    if (root === path.parse(root).root) return path.isAbsolute(candidate)
    return candidate === root || candidate.startsWith(root + path.sep)
  }

  // Helper used by all boundary checks: a path is allowed if it falls
  // under the active-project root OR under any per-user whitelist entry.
  // Same predicate used for both browse-side (isWithinProject) and
  // mutation-side (isWithinStrictProject).
  function isAllowedPath(candidate: string, projectRoot: string): boolean {
    return isWithinRoot(candidate, projectRoot) || isInAccessWhitelist(candidate)
  }

  async function isWithinProject(targetPath: string): Promise<boolean> {
    const root = await getProjectRootReal()
    const resolved = path.resolve(targetPath)
    if (!isAllowedPath(resolved, root)) {
      return false
    }
    const real = await fs.promises.realpath(targetPath).catch(() => undefined)
    if (real && !isAllowedPath(real, root)) {
      return false
    }
    if (!real) {
      const parentReal = await fs.promises.realpath(path.dirname(targetPath)).catch(() => undefined)
      if (parentReal && !isAllowedPath(parentReal, root)) {
        return false
      }
    }
    return true
  }

  async function isWithinStrictProject(targetPath: string): Promise<boolean> {
    const root = await getStrictProjectRootReal()
    const resolved = path.resolve(targetPath)
    if (!isAllowedPath(resolved, root)) return false
    const real = await fs.promises.realpath(targetPath).catch(() => undefined)
    if (real && !isAllowedPath(real, root)) return false
    if (!real) {
      const parentReal = await fs.promises.realpath(path.dirname(targetPath)).catch(() => undefined)
      if (parentReal && !isAllowedPath(parentReal, root)) return false
    }
    return true
  }

  async function assertWithinProject(targetPath: string): Promise<string> {
    const root = await getProjectRootReal()
    const resolved = path.resolve(targetPath)
    const globalBrowse = allowGlobalFilesystemBrowse()
    if (!isAllowedPath(resolved, root)) {
      log.warn("assertWithinProject denied (resolved outside root and whitelist)", {
        targetPath,
        resolved,
        root,
        instanceDirectory: Instance.directory,
        projectID: Instance.project.id,
        globalBrowse,
      })
      throw new Error(`Access denied: path escapes project directory (resolved=${resolved}, root=${root})`)
    }
    const real = await fs.promises.realpath(targetPath).catch(() => undefined)
    if (real && !isAllowedPath(real, root)) {
      log.warn("assertWithinProject denied (realpath outside root and whitelist)", {
        targetPath,
        resolved,
        real,
        root,
        instanceDirectory: Instance.directory,
        projectID: Instance.project.id,
        globalBrowse,
      })
      throw new Error(`Access denied: path escapes project directory (real=${real}, root=${root})`)
    }
    if (!real) {
      const parentReal = await fs.promises.realpath(path.dirname(targetPath)).catch(() => undefined)
      if (parentReal && !isAllowedPath(parentReal, root)) {
        log.warn("assertWithinProject denied (parent realpath outside root and whitelist)", {
          targetPath,
          resolved,
          parentReal,
          root,
          instanceDirectory: Instance.directory,
          projectID: Instance.project.id,
          globalBrowse,
        })
        throw new Error(`Access denied: path escapes project directory (parent=${parentReal}, root=${root})`)
      }
    }
    return real ?? resolved
  }

  function operationError(code: OperationCode, message: string, data?: Record<string, unknown>) {
    const status = (() => {
      if (code === "FILE_OP_PATH_ESCAPE" || code === "FILE_OP_PERMISSION_DENIED") return 403
      if (code === "FILE_OP_SOURCE_NOT_FOUND") return 404
      if (code === "FILE_OP_DUPLICATE" || code === "FILE_RECYCLEBIN_RESTORE_CONFLICT") return 409
      if (code === "FILE_UPLOAD_TOO_LARGE") return 413
      return 400
    })()
    return new OperationError(code, message, status, data)
  }

  // Default cap chosen to match a typical project asset size budget. TODO:
  // promote to /etc/opencode/tweaks.cfg key once the spec.md "configurable
  // size limit" follow-up is approved (see plans/20260509_web-file-upload
  // §Requirement: Enforce upload size limit). Env override exists for ops
  // who need to lift the cap before that landing.
  const UPLOAD_MAX_BYTES_DEFAULT = 64 * 1024 * 1024
  function uploadMaxBytes(): number {
    const raw = Bun.env.OPENCODE_FILE_UPLOAD_MAX_BYTES
    if (!raw) return UPLOAD_MAX_BYTES_DEFAULT
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return UPLOAD_MAX_BYTES_DEFAULT
    return parsed
  }

  async function assertOperationWithinProject(targetPath: string): Promise<string> {
    if (!(await isWithinStrictProject(targetPath))) {
      throw operationError("FILE_OP_PATH_ESCAPE", "Operation target is outside the active project.", {
        path: targetPath,
      })
    }
    return path.resolve(targetPath)
  }

  function normalizeRelative(targetPath: string): string {
    return path.relative(Instance.directory, targetPath).replaceAll("\\", "/")
  }

  function parentRelative(targetPath: string): string {
    return normalizeRelative(path.dirname(targetPath))
  }

  function validateBasename(name: string): string {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
      throw operationError("FILE_OP_INVALID_NAME", "Filename is invalid.", { name })
    }
    if (path.basename(name) !== name || path.win32.basename(name) !== name) {
      throw operationError("FILE_OP_INVALID_NAME", "Filename is invalid.", { name })
    }
    return name
  }

  async function assertDirectory(targetPath: string): Promise<void> {
    const stat = await fs.promises.stat(targetPath).catch((err) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        throw operationError("FILE_OP_SOURCE_NOT_FOUND", "Source file or folder no longer exists.", {
          path: targetPath,
        })
      }
      throw err
    })
    if (!stat.isDirectory()) {
      throw operationError("FILE_OP_TARGET_NOT_DIRECTORY", "Operation target is not a directory.", { path: targetPath })
    }
  }

  async function assertSourceExists(targetPath: string): Promise<fs.Stats> {
    return await fs.promises.stat(targetPath).catch((err) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        throw operationError("FILE_OP_SOURCE_NOT_FOUND", "Source file or folder no longer exists.", {
          path: targetPath,
        })
      }
      throw err
    })
  }

  async function assertDestinationAvailable(targetPath: string): Promise<void> {
    // Bun.file().exists() only reports for regular files — directories
    // always return false, which let dir-vs-dir collisions slip past this
    // guard and hit fs.cp later as a misleading ENOENT. Use fs.stat (which
    // covers files, directories, symlinks, etc.) and treat any successful
    // stat as "destination occupied".
    const stat = await fs.promises.stat(targetPath).catch(() => undefined)
    if (stat) {
      throw operationError("FILE_OP_DUPLICATE", "A file or folder with this name already exists.", { path: targetPath })
    }
  }

  function isAlreadyExistsError(err: unknown): boolean {
    return !!err && typeof err === "object" && "code" in err && err.code === "EEXIST"
  }

  async function copyWithoutOverwrite(source: string, destination: string): Promise<void> {
    await fs.promises.cp(source, destination, { recursive: true, errorOnExist: true, force: false }).catch((err) => {
      if (isAlreadyExistsError(err)) {
        throw operationError("FILE_OP_DUPLICATE", "A file or folder with this name already exists.", {
          path: destination,
        })
      }
      throw err
    })
  }

  function isCrossDeviceError(err: unknown): boolean {
    return !!err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "EXDEV"
  }

  async function moveWithoutOverwrite(source: string, destination: string): Promise<void> {
    if (source === destination) return
    // Pre-check: rename() does not check destination collision the same way
    // copy+rm did, so we keep the explicit DUPLICATE error code surface.
    await assertDestinationAvailable(destination)
    // Prefer atomic rename (metadata-only) — critical for cloud-only
    // placeholder files like Google Drive .gdoc shortcuts where read()
    // throws EIO. Falls back to copy+rm only when source and destination
    // sit on different filesystems (EXDEV).
    try {
      await fs.promises.rename(source, destination)
      return
    } catch (err) {
      if (!isCrossDeviceError(err)) throw err
    }
    await copyWithoutOverwrite(source, destination)
    await fs.promises.rm(source, { recursive: true, force: false })
  }

  async function moveOverwriting(source: string, destination: string): Promise<void> {
    if (source === destination) return
    // Caller already confirmed overwrite. Same rename-first / cp-fallback
    // pattern, but on same-fs path we rm the existing destination first so
    // rename can land. fs.promises.rename DOES atomically replace the
    // destination on POSIX, but explicit pre-rm makes the semantics
    // identical for both files and directories on drvfs / 9p (which has
    // historically been finicky about overwrite-rename of dirs).
    await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => {})
    try {
      await fs.promises.rename(source, destination)
      return
    } catch (err) {
      if (!isCrossDeviceError(err)) throw err
    }
    await fs.promises.cp(source, destination, { recursive: true, force: true, errorOnExist: false })
    await fs.promises.rm(source, { recursive: true, force: false })
  }

  async function copyOverwriting(source: string, destination: string): Promise<void> {
    if (source === destination) return
    await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => {})
    await fs.promises.cp(source, destination, { recursive: true, force: true, errorOnExist: false })
  }

  async function nodeFromPath(targetPath: string): Promise<Node> {
    const stat = await fs.promises.stat(targetPath)
    const relativePath = normalizeRelative(targetPath)
    return {
      name: path.basename(targetPath),
      path: relativePath,
      absolute: targetPath,
      type: stat.isDirectory() ? "directory" : "file",
      ignored: false,
    }
  }

  // Decide whether an absolute input path should be used as-is (vs joined to
  // Instance.directory). Absolute paths are honoured when global FS browsing
  // is enabled OR when the path falls under the per-user access whitelist.
  // This lets whitelisted roots like /mnt/g be addressed directly even when
  // global browsing is off.
  function shouldUseAbsoluteInput(inputPath: string): boolean {
    if (!path.isAbsolute(inputPath)) return false
    return allowGlobalFilesystemBrowse() || isInAccessWhitelist(inputPath)
  }

  async function resolveProjectPath(inputPath: string): Promise<string> {
    const requested = shouldUseAbsoluteInput(inputPath) ? inputPath : path.join(Instance.directory, inputPath)
    return await assertOperationWithinProject(requested)
  }

  async function resolveProjectParent(inputPath: string): Promise<string> {
    const resolved = await resolveProjectPath(inputPath)
    await assertDirectory(resolved)
    return resolved
  }

  function recyclebinRoot(): string {
    return path.join(Instance.directory, "recyclebin")
  }

  function recycleMetadataPath(tombstonePath: string): string {
    return tombstonePath + ".opencode-recycle.json"
  }

  // Detect whether source and the project recyclebin live on the same
  // filesystem. Drives the "skip recyclebin, just unlink" branch in
  // deleteToRecyclebin: external mounts (e.g. Google Drive 9p drvfs) are
  // permanently deleted locally and the cloud client (GD Desktop, etc.)
  // takes care of moving the cloud copy into its own trash.
  async function isSameFilesystemAsProject(source: string): Promise<boolean> {
    const projectStat = await fs.promises.stat(Instance.directory).catch(() => undefined)
    const sourceStat = await fs.promises.stat(source).catch(() => undefined)
    if (!projectStat || !sourceStat) return false
    return projectStat.dev === sourceStat.dev
  }

  async function uniqueRecyclePath(sourcePath: string): Promise<string> {
    const root = recyclebinRoot()
    await fs.promises.mkdir(root, { recursive: true })
    await assertOperationWithinProject(root)
    const parsed = path.parse(sourcePath)
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    for (let index = 0; index < 100; index++) {
      const suffix = index === 0 ? "" : `-${index}`
      const candidate = path.join(root, `${parsed.name}.${stamp}${suffix}${parsed.ext}`)
      if (!(await Bun.file(candidate).exists()) && !(await Bun.file(recycleMetadataPath(candidate)).exists()))
        return candidate
    }
    throw operationError("FILE_OP_DUPLICATE", "A file or folder with this name already exists.")
  }

  async function ensureWritableDirectory(targetPath: string): Promise<OperationCode | undefined> {
    try {
      await fs.promises.access(targetPath, fs.constants.W_OK)
      return undefined
    } catch {
      return "FILE_OP_PERMISSION_DENIED"
    }
  }

  async function warnIfOutsideProject(paths: string[], context: string): Promise<void> {
    if (paths.length === 0) return
    const root = await getProjectRootReal()
    let outsideCount = 0
    const samples: string[] = []
    for (const rel of paths) {
      const full = path.join(Instance.directory, rel)
      const real = await fs.promises.realpath(full).catch(() => undefined)
      const candidate = real ?? path.resolve(full)
      if (!isWithinRoot(candidate, root)) {
        outsideCount += 1
        if (samples.length < 5) samples.push(rel)
      }
    }
    if (outsideCount > 0) {
      log.warn("path escapes project directory", {
        context,
        outsideCount,
        samples,
      })
    }
  }

  async function filterWithinProject(paths: string[]): Promise<string[]> {
    if (paths.length === 0) return paths
    const root = await getProjectRootReal()
    const safe: string[] = []
    for (const rel of paths) {
      const full = path.join(Instance.directory, rel)
      const real = await fs.promises.realpath(full).catch(() => undefined)
      const candidate = real ?? path.resolve(full)
      if (isWithinRoot(candidate, root)) {
        safe.push(rel)
      }
    }
    return safe
  }

  async function shouldEncode(file: BunFile): Promise<boolean> {
    const type = file.type?.toLowerCase()
    log.info("shouldEncode", { type })
    if (!type) return false

    if (type.startsWith("text/")) return false
    if (type.includes("charset=")) return false

    const parts = type.split("/", 2)
    const top = parts[0]

    const tops = ["image", "audio", "video", "font", "model", "multipart"]
    if (tops.includes(top)) return true

    return false
  }

  export const Event = {
    Edited: BusEvent.define(
      "file.edited",
      z.object({
        file: z.string(),
      }),
    ),
    OperationRequested: BusEvent.define(
      "file.operation.requested",
      z.object({
        operation: z.string(),
        input: z.record(z.string(), z.unknown()),
      }),
    ),
    OperationCompleted: BusEvent.define(
      "file.operation.completed",
      z.object({
        operation: z.string(),
        source: z.string().optional(),
        destination: z.string().optional(),
        durationMs: z.number(),
      }),
    ),
    OperationRejected: BusEvent.define(
      "file.operation.rejected",
      z.object({
        operation: z.string(),
        code: OperationCode,
        message: z.string(),
        durationMs: z.number(),
      }),
    ),
  }

  function publishFireAndForget<Def extends BusEvent.Definition>(def: Def, properties: z.output<Def["properties"]>) {
    Bus.publish(def, properties).catch((err) =>
      log.warn("file event publish failed", { type: def.type, error: String(err) }),
    )
  }

  function redactTelemetryInput(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      if (value instanceof Blob) {
        out[key] = {
          kind: "blob",
          size: value.size,
          type: value.type || "application/octet-stream",
        }
      } else {
        out[key] = value
      }
    }
    return out
  }

  async function withTelemetry<T>(
    operationKind: string,
    input: Record<string, unknown>,
    fn: () => Promise<T>,
    extract: (result: T) => { source?: string; destination?: string } = () => ({}),
  ): Promise<T> {
    const startedAt = Date.now()
    publishFireAndForget(Event.OperationRequested, {
      operation: operationKind,
      input: redactTelemetryInput(input),
    })
    try {
      const result = await fn()
      const { source, destination } = extract(result)
      publishFireAndForget(Event.OperationCompleted, {
        operation: operationKind,
        source,
        destination,
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (err) {
      if (err instanceof OperationError) {
        publishFireAndForget(Event.OperationRejected, {
          operation: operationKind,
          code: err.code,
          message: err.message,
          durationMs: Date.now() - startedAt,
        })
      }
      throw err
    }
  }

  function operationResultParts(result: OperationResult): { source?: string; destination?: string } {
    return { source: result.source, destination: result.destination }
  }

  async function createState() {
    type Entry = { files: string[]; dirs: string[] }
    let cache: Entry = { files: [], dirs: [] }
    let fetching = false

    const isGlobalHome = Instance.directory === Global.Path.home && Instance.project.id === "global"

    const fn = async (result: Entry) => {
      // Disable scanning if in root of file system
      if (Instance.directory === path.parse(Instance.directory).root) return
      fetching = true

      if (isGlobalHome) {
        const dirs = new Set<string>()
        const ignore = new Set<string>()

        if (process.platform === "darwin") ignore.add("Library")
        if (process.platform === "win32") ignore.add("AppData")

        const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
        const shouldIgnore = (name: string) => name.startsWith(".") || ignore.has(name)
        const shouldIgnoreNested = (name: string) => name.startsWith(".") || ignoreNested.has(name)

        const top = await fs.promises
          .readdir(Instance.directory, { withFileTypes: true })
          .catch(() => [] as fs.Dirent[])

        for (const entry of top) {
          if (!entry.isDirectory()) continue
          if (shouldIgnore(entry.name)) continue
          dirs.add(entry.name + "/")

          const base = path.join(Instance.directory, entry.name)
          const children = await fs.promises.readdir(base, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
          for (const child of children) {
            if (!child.isDirectory()) continue
            if (shouldIgnoreNested(child.name)) continue
            dirs.add(entry.name + "/" + child.name + "/")
          }
        }

        result.dirs = Array.from(dirs).toSorted()
        cache = result
        fetching = false
        return
      }

      const set = new Set<string>()
      for await (const file of Ripgrep.files({ cwd: Instance.directory })) {
        result.files.push(file)
        let current = file
        while (true) {
          const dir = path.dirname(current)
          if (dir === ".") break
          if (dir === current) break
          current = dir
          if (set.has(dir)) continue
          set.add(dir)
          result.dirs.push(dir + "/")
        }
      }
      cache = result
      fetching = false
    }
    fn(cache)

    return {
      async files() {
        if (!fetching) {
          fn({
            files: [],
            dirs: [],
          })
        }
        return cache
      },
    }
  }

  let stateGetter: (() => Promise<Awaited<ReturnType<typeof createState>>>) | undefined
  let fallbackState: Promise<Awaited<ReturnType<typeof createState>>> | undefined

  function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState)
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  export function init() {
    state()
  }

  async function outputText(input: Buffer | ReadableStream<Uint8Array>) {
    if (Buffer.isBuffer(input)) return input.toString()
    return await Bun.readableStreamToText(input)
  }

  export async function status(input?: { paths?: string[] }) {
    const project = Instance.project
    if (project.vcs !== "git") return []

    const requestedPaths = [
      ...new Set(
        (input?.paths ?? []).map((item) =>
          path.relative(Instance.directory, path.join(Instance.directory, item)).replaceAll("\\", "/"),
        ),
      ),
    ].filter(Boolean)
    const withPathspec = (args: string[]) => (requestedPaths.length > 0 ? [...args, "--", ...requestedPaths] : args)

    const diffResult = await git(
      withPathspec(["-c", "safe.directory=*", "-c", "core.quotepath=false", "diff", "--numstat", "HEAD"]),
      {
        cwd: Instance.directory,
      },
    )
    const diffOutput = await diffResult.text()

    const changedFiles: Info[] = []

    if (diffOutput.trim()) {
      const lines = diffOutput.trim().split("\n")
      for (const line of lines) {
        const [added, removed, filepath] = line.split("\t")
        changedFiles.push({
          path: filepath,
          added: added === "-" ? 0 : parseInt(added, 10),
          removed: removed === "-" ? 0 : parseInt(removed, 10),
          status: "modified",
        })
      }
    }

    const untrackedResult = await git(
      withPathspec([
        "-c",
        "safe.directory=*",
        "-c",
        "core.quotepath=false",
        "ls-files",
        "--others",
        "--exclude-standard",
      ]),
      { cwd: Instance.directory },
    )
    const untrackedOutput = await untrackedResult.text()

    if (untrackedOutput.trim()) {
      const untrackedFiles = untrackedOutput.trim().split("\n")
      for (const filepath of untrackedFiles) {
        try {
          const content = await Bun.file(path.join(Instance.directory, filepath)).text()
          const lines = content.split("\n").length
          changedFiles.push({
            path: filepath,
            added: lines,
            removed: 0,
            status: "added",
          })
        } catch {
          continue
        }
      }
    }

    // Get deleted files
    const deletedResult = await git(
      withPathspec([
        "-c",
        "safe.directory=*",
        "-c",
        "core.quotepath=false",
        "diff",
        "--name-only",
        "--diff-filter=D",
        "HEAD",
      ]),
      { cwd: Instance.directory },
    )
    const deletedOutput = await deletedResult.text()

    if (deletedOutput.trim()) {
      const deletedFiles = deletedOutput.trim().split("\n")
      for (const filepath of deletedFiles) {
        changedFiles.push({
          path: filepath,
          added: 0,
          removed: 0, // Could get original line count but would require another git command
          status: "deleted",
        })
      }
    }

    const normalized = changedFiles.map((x) => {
      const full = path.isAbsolute(x.path) ? x.path : path.join(Instance.directory, x.path)
      return {
        ...x,
        path: path.relative(Instance.directory, full),
      }
    })

    if (process.env.OPENCODE_DEBUG_REVIEW_CHECKPOINT === "1") {
      const [diffErr, untrackedErr, deletedErr] = await Promise.all([
        outputText(diffResult.stderr),
        outputText(untrackedResult.stderr),
        outputText(deletedResult.stderr),
      ])

      log.info("checkpoint:file.status", {
        directory: Instance.directory,
        vcs: project.vcs,
        diffExit: diffResult.exitCode,
        untrackedExit: untrackedResult.exitCode,
        deletedExit: deletedResult.exitCode,
        diffErr: diffErr.trim().slice(0, 300),
        untrackedErr: untrackedErr.trim().slice(0, 300),
        deletedErr: deletedErr.trim().slice(0, 300),
        statusCount: normalized.length,
      })
    }

    const hydrated = await Promise.all(
      normalized.map(async (item) => {
        const full = path.join(Instance.directory, item.path)

        const readHeadText = async () => {
          const original = await $`git -c safe.directory=* -c core.quotepath=false show HEAD:${item.path}`
            .cwd(Instance.directory)
            .quiet()
            .nothrow()
            .text()
          return original
        }

        const readWorkingText = async () => {
          const bunFile = Bun.file(full)
          if (!(await bunFile.exists())) return ""
          if (await shouldEncode(bunFile)) return ""
          return await bunFile.text().catch(() => "")
        }

        if (item.status === "added") {
          return {
            ...item,
            before: "",
            after: await readWorkingText(),
          }
        }

        if (item.status === "deleted") {
          return {
            ...item,
            before: await readHeadText(),
            after: "",
          }
        }

        return {
          ...item,
          before: await readHeadText(),
          after: await readWorkingText(),
        }
      }),
    )

    return hydrated
  }

  export async function read(file: string): Promise<Content> {
    using _ = log.time("read", { file })
    const project = Instance.project
    const full = path.join(Instance.directory, file)
    const validated = await assertWithinProject(full)

    // Fast path: check extension before any filesystem operations
    if (path.extname(file).toLowerCase() === ".pdf") {
      const bunFile = Bun.file(full)
      if (await bunFile.exists()) {
        const buffer = await bunFile.arrayBuffer().catch(() => new ArrayBuffer(0))
        const content = Buffer.from(buffer).toString("base64")
        return { type: "text", content, mimeType: "application/pdf", encoding: "base64" }
      }
      return { type: "text", content: "" }
    }

    if (isImageByExtension(file)) {
      const bunFile = Bun.file(full)
      if (await bunFile.exists()) {
        const buffer = await bunFile.arrayBuffer().catch(() => new ArrayBuffer(0))
        const content = Buffer.from(buffer).toString("base64")
        const mimeType = getImageMimeType(file)
        return { type: "text", content, mimeType, encoding: "base64" }
      }
      return { type: "text", content: "" }
    }

    const text = isTextByExtension(file) || isTextByName(file)

    if (isBinaryByExtension(file) && !text) {
      return { type: "binary", content: "" }
    }

    const bunFile = Bun.file(full)

    if (!(await bunFile.exists())) {
      if (project.vcs === "git") {
        const original = await $`git -c safe.directory=* show HEAD:${file}`
          .cwd(Instance.directory)
          .quiet()
          .nothrow()
          .text()
        if (original.trim()) {
          const patch = structuredPatch(file, file, original, "", "old", "new", {
            context: Infinity,
            ignoreWhitespace: true,
          })
          const diff = formatPatch(patch)
          return { type: "text", content: "", patch, diff }
        }
      }
      return { type: "text", content: "" }
    }

    const encode = text ? false : await shouldEncode(bunFile)
    const mimeType = bunFile.type || "application/octet-stream"

    if (encode && !isImage(mimeType)) {
      return { type: "binary", content: "", mimeType }
    }

    if (encode) {
      const buffer = await bunFile.arrayBuffer().catch(() => new ArrayBuffer(0))
      const content = Buffer.from(buffer).toString("base64")
      return { type: "text", content, mimeType, encoding: "base64" }
    }

    const content = await bunFile
      .text()
      .catch(() => "")
      .then((x) => x.trim())

    if (project.vcs === "git") {
      let diff = await $`git -c safe.directory=* diff ${file}`.cwd(Instance.directory).quiet().nothrow().text()
      if (!diff.trim())
        diff = await $`git -c safe.directory=* diff --staged ${file}`.cwd(Instance.directory).quiet().nothrow().text()
      if (diff.trim()) {
        const original = await $`git -c safe.directory=* show HEAD:${file}`
          .cwd(Instance.directory)
          .quiet()
          .nothrow()
          .text()
        const patch = structuredPatch(file, file, original, content, "old", "new", {
          context: Infinity,
          ignoreWhitespace: true,
        })
        const diff = formatPatch(patch)
        return { type: "text", content, patch, diff }
      }
    }
    return { type: "text", content }
  }

  export async function list(dir?: string) {
    const exclude = [".git", ".DS_Store"]
    const project = Instance.project
    let ignored = (_: string) => false
    if (project.vcs === "git") {
      const ig = ignore()
      const gitignore = Bun.file(path.join(Instance.worktree, ".gitignore"))
      if (await gitignore.exists()) {
        ig.add(await gitignore.text())
      }
      const ignoreFile = Bun.file(path.join(Instance.worktree, ".ignore"))
      if (await ignoreFile.exists()) {
        ig.add(await ignoreFile.text())
      }
      ignored = ig.ignores.bind(ig)
    }
    const requested =
      dir && shouldUseAbsoluteInput(dir) ? dir : dir ? path.join(Instance.directory, dir) : Instance.directory
    const resolved = await assertWithinProject(requested)

    const entries = await fs.promises.readdir(resolved, {
      withFileTypes: true,
    })
    const nodes: Node[] = []
    const stats = await Promise.all(
      entries.map((entry) =>
        fs.promises.stat(path.join(resolved, entry.name)).catch(() => undefined),
      ),
    )
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (exclude.includes(entry.name)) continue
      const fullPath = path.join(resolved, entry.name)
      const relativePath = path.relative(Instance.directory, fullPath)
      const stat = stats[i]
      // Symlinks: Dirent.isDirectory() always returns false because the
      // Dirent reflects the lstat (the link itself), not the target. Use
      // stats[i] (which follows the link via fs.promises.stat) so a
      // symlink-to-dir is reported as type "directory" and the file tree
      // treats it as expandable; symlink-to-file as "file". When stat
      // fails (broken / dangling link, target outside project, etc.) fall
      // back to the dirent verdict so we never throw on listing.
      const type: Node["type"] = stat
        ? stat.isDirectory()
          ? "directory"
          : "file"
        : entry.isDirectory()
          ? "directory"
          : "file"
      const escapedRelative = relativePath === "" || relativePath === ".." || relativePath.startsWith("../")
      const node: Node = {
        name: entry.name,
        path: relativePath,
        absolute: fullPath,
        type,
        ignored: escapedRelative ? false : ignored(type === "directory" ? relativePath + "/" : relativePath),
      }
      if (stat) {
        if (type === "file") node.size = stat.size
        node.modifiedAt = stat.mtimeMs
      }
      nodes.push(node)
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }

  export async function createDirectory(input: { path: string }): Promise<DirectoryCreateResult> {
    const requested = shouldUseAbsoluteInput(input.path) ? input.path : path.join(Instance.directory, input.path)
    const resolved = await assertWithinProject(requested)
    await fs.promises.mkdir(resolved)
    const relativePath = path.relative(Instance.directory, resolved)
    return {
      name: path.basename(resolved),
      path: relativePath,
      absolute: resolved,
      type: "directory",
      ignored: false,
    }
  }

  export async function create(input: {
    parent: string
    name: string
    type: "file" | "directory"
  }): Promise<OperationResult> {
    const operationKind = input.type === "directory" ? "create-directory" : "create-file"
    return withTelemetry(operationKind, input as unknown as Record<string, unknown>, async () => {
      const parent = await resolveProjectParent(input.parent)
      const name = validateBasename(input.name)
      const destination = path.join(parent, name)
      await assertOperationWithinProject(destination)
      await assertDestinationAvailable(destination)
      if (input.type === "directory") await fs.promises.mkdir(destination)
      else await fs.promises.writeFile(destination, "", { flag: "wx" })
      return {
        operation: input.type === "directory" ? "create-directory" : "create-file",
        destination: normalizeRelative(destination),
        node: await nodeFromPath(destination),
        affectedDirectories: [normalizeRelative(parent)],
      }
    }, operationResultParts)
  }

  export async function rename(input: { path: string; name: string }): Promise<OperationResult> {
    return withTelemetry("rename", input as unknown as Record<string, unknown>, async () => {
      const source = await resolveProjectPath(input.path)
      await assertSourceExists(source)
      const destination = path.join(path.dirname(source), validateBasename(input.name))
      await assertOperationWithinProject(destination)
      if (source !== destination) await assertDestinationAvailable(destination)
      await moveWithoutOverwrite(source, destination)
      return {
        operation: "rename",
        source: normalizeRelative(source),
        destination: normalizeRelative(destination),
        node: await nodeFromPath(destination),
        affectedDirectories: [parentRelative(destination)],
      }
    }, operationResultParts)
  }

  // Phase 4.3 — external destination resolution. Source must always remain
  // inside the active project. When scope === "external", the destination
  // bypasses assertOperationWithinProject and is instead canonicalized +
  // write-probed inline (mirrors destinationPreflight). Returns the
  // resolved absolute parent + a presentational path for the result.
  async function resolveDestinationParent(
    requested: string,
    scope: "active-project" | "external" | undefined,
  ): Promise<{ absolute: string; presentation: string; external: boolean }> {
    if (scope === "external") {
      const canonical = path.resolve(requested)
      const stat = await fs.promises.stat(canonical).catch(() => undefined)
      if (!stat) {
        throw operationError("FILE_OP_DESTINATION_AMBIGUOUS", "Destination path cannot be resolved safely.", {
          path: canonical,
        })
      }
      if (!stat.isDirectory()) {
        throw operationError("FILE_OP_TARGET_NOT_DIRECTORY", "Operation target is not a directory.", {
          path: canonical,
        })
      }
      const permission = await ensureWritableDirectory(canonical)
      if (permission) {
        throw operationError(permission, "Current user cannot write to the destination.", { path: canonical })
      }
      return { absolute: canonical, presentation: canonical, external: true }
    }
    const absolute = await resolveProjectParent(requested)
    return { absolute, presentation: normalizeRelative(absolute), external: false }
  }

  function destinationDisplay(absolute: string, external: boolean): string {
    return external ? absolute : normalizeRelative(absolute)
  }

  export async function move(input: {
    source: string
    destinationParent: string
    scope?: "active-project" | "external"
    overwrite?: boolean
  }): Promise<OperationResult> {
    return withTelemetry("move", input as unknown as Record<string, unknown>, async () => {
      const source = await resolveProjectPath(input.source)
      await assertSourceExists(source)
      const parent = await resolveDestinationParent(input.destinationParent, input.scope)
      const destination = path.join(parent.absolute, path.basename(source))
      if (!parent.external) await assertOperationWithinProject(destination)
      if (input.overwrite === true) {
        await moveOverwriting(source, destination)
      } else {
        await moveWithoutOverwrite(source, destination)
      }
      const destinationDisplayPath = destinationDisplay(destination, parent.external)
      return {
        operation: "move",
        source: normalizeRelative(source),
        destination: destinationDisplayPath,
        node: parent.external ? undefined : await nodeFromPath(destination),
        affectedDirectories: [
          ...new Set(
            parent.external
              ? [parentRelative(source)]
              : [parentRelative(source), normalizeRelative(parent.absolute)],
          ),
        ],
      }
    }, operationResultParts)
  }

  export async function copy(input: {
    source: string
    destinationParent: string
    scope?: "active-project" | "external"
    overwrite?: boolean
  }): Promise<OperationResult> {
    return withTelemetry("copy", input as unknown as Record<string, unknown>, async () => {
      const source = await resolveProjectPath(input.source)
      await assertSourceExists(source)
      const parent = await resolveDestinationParent(input.destinationParent, input.scope)
      const destination = path.join(parent.absolute, path.basename(source))
      if (!parent.external) await assertOperationWithinProject(destination)
      if (input.overwrite === true) {
        await copyOverwriting(source, destination)
      } else {
        await assertDestinationAvailable(destination)
        await copyWithoutOverwrite(source, destination)
      }
      const destinationDisplayPath = destinationDisplay(destination, parent.external)
      return {
        operation: "copy",
        source: normalizeRelative(source),
        destination: destinationDisplayPath,
        node: parent.external ? undefined : await nodeFromPath(destination),
        affectedDirectories: parent.external ? [] : [normalizeRelative(parent.absolute)],
      }
    }, operationResultParts)
  }

  export async function deleteToRecyclebin(input: { path: string; confirmed: boolean }): Promise<OperationResult> {
    return withTelemetry("delete-to-recyclebin", input as unknown as Record<string, unknown>, async () => {
      if (!input.confirmed) {
        throw operationError("FILE_OP_CONFIRMATION_REQUIRED", "This destructive operation requires confirmation.")
      }
      const source = await resolveProjectPath(input.path)
      await assertSourceExists(source)

      // Cross-filesystem source (e.g. Google Drive bind mount on 9p drvfs)
      // skips the local recyclebin entirely and unlinks. Rationale:
      //   1. Cross-fs rename throws EXDEV; the copy+rm fallback fails
      //      with EIO on cloud-only placeholder files (.gdoc et al).
      //   2. The remote sync client (GD Desktop, etc.) sees the local
      //      unlink and routes the file to its own cloud trash, so the
      //      "trash" affordance still exists — just owned by the cloud
      //      provider, not opencode.
      // The OperationResult for this path omits `destination` so the
      // frontend toast can read "Permanently deleted (cloud client
      // handles trash)" instead of "Moved to recyclebin".
      const sameFs = await isSameFilesystemAsProject(source)
      if (!sameFs) {
        await fs.promises.rm(source, { recursive: true, force: false })
        return {
          operation: "delete-to-recyclebin",
          source: normalizeRelative(source),
          // destination intentionally omitted.
          affectedDirectories: [parentRelative(source)],
        }
      }

      // Same-fs path: rename into project recyclebin (atomic, metadata-
      // only — works for any local file including content we cannot
      // read). Metadata sidecar written AFTER rename so a partial
      // rename never orphans it.
      const stat = await fs.promises.stat(source)
      const destination = await uniqueRecyclePath(source)
      const metadata = {
        originalPath: normalizeRelative(source),
        tombstonePath: normalizeRelative(destination),
        deletedAt: new Date().toISOString(),
        type: stat.isDirectory() ? "directory" : "file",
      }
      const metadataFile = recycleMetadataPath(destination)
      await fs.promises.rename(source, destination)
      await fs.promises.writeFile(metadataFile, JSON.stringify(metadata, null, 2), { flag: "wx" }).catch(() => {})
      return {
        operation: "delete-to-recyclebin",
        source: metadata.originalPath,
        destination: metadata.tombstonePath,
        node: await nodeFromPath(destination),
        affectedDirectories: [...new Set([parentRelative(source), normalizeRelative(recyclebinRoot())])],
      }
    }, operationResultParts)
  }

  export async function restoreFromRecyclebin(input: { tombstonePath: string }): Promise<OperationResult> {
    return withTelemetry("restore-from-recyclebin", input as unknown as Record<string, unknown>, async () => {
      const tombstone = await resolveProjectPath(input.tombstonePath)
      const recycleRoot = await assertOperationWithinProject(recyclebinRoot())
      if (!isWithinRoot(tombstone, recycleRoot)) {
        throw operationError("FILE_RECYCLEBIN_METADATA_INVALID", "Recyclebin metadata is missing or unsafe.")
      }
      const metadataFile = recycleMetadataPath(tombstone)
      const metadata = await Bun.file(metadataFile)
        .json()
        .catch(() => undefined)
      const parsed = z
        .object({
          originalPath: z.string().min(1),
          tombstonePath: z.string().min(1),
          deletedAt: z.string(),
          type: z.enum(["file", "directory"]),
        })
        .safeParse(metadata)
      if (!parsed.success || parsed.data.tombstonePath !== normalizeRelative(tombstone)) {
        throw operationError("FILE_RECYCLEBIN_METADATA_INVALID", "Recyclebin metadata is missing or unsafe.")
      }
      const destination = path.join(Instance.directory, parsed.data.originalPath)
      await assertOperationWithinProject(destination)
      await assertOperationWithinProject(path.dirname(destination))
      await assertDestinationAvailable(destination).catch((err) => {
        if (err instanceof OperationError && err.code === "FILE_OP_DUPLICATE") {
          throw operationError("FILE_RECYCLEBIN_RESTORE_CONFLICT", "Restore target already exists.", {
            path: parsed.data.originalPath,
          })
        }
        throw err
      })
      // Restore is also a metadata-only move semantically: from recyclebin
      // back to the original path. Use rename-first so cloud-only
      // placeholder files survive restore. Fall back to copy+rm on EXDEV.
      try {
        await fs.promises.rename(tombstone, destination)
      } catch (err) {
        if (!isCrossDeviceError(err)) {
          if (err instanceof OperationError && err.code === "FILE_OP_DUPLICATE") {
            throw operationError("FILE_RECYCLEBIN_RESTORE_CONFLICT", "Restore target already exists.", {
              path: parsed.data.originalPath,
            })
          }
          throw err
        }
        await copyWithoutOverwrite(tombstone, destination).catch((err2) => {
          if (err2 instanceof OperationError && err2.code === "FILE_OP_DUPLICATE") {
            throw operationError("FILE_RECYCLEBIN_RESTORE_CONFLICT", "Restore target already exists.", {
              path: parsed.data.originalPath,
            })
          }
          throw err2
        })
        await fs.promises.rm(tombstone, { recursive: true, force: false })
      }
      await fs.promises.rm(metadataFile, { force: true })
      return {
        operation: "restore-from-recyclebin",
        source: parsed.data.tombstonePath,
        destination: parsed.data.originalPath,
        node: await nodeFromPath(destination),
        affectedDirectories: [...new Set([parentRelative(destination), normalizeRelative(recyclebinRoot())])],
      }
    }, operationResultParts)
  }

  export async function destinationPreflight(input: {
    destinationParent: string
    scope: "active-project" | "external"
  }): Promise<DestinationPreflightResult> {
    const candidate =
      input.scope === "external"
        ? path.resolve(input.destinationParent)
        : path.join(Instance.directory, input.destinationParent)
    if (input.scope === "active-project" && !(await isWithinStrictProject(candidate))) {
      return { canonicalPath: candidate, writable: false, reason: "FILE_OP_PATH_ESCAPE" }
    }
    const stat = await fs.promises.stat(candidate).catch(() => undefined)
    if (!stat) return { canonicalPath: candidate, writable: false, reason: "FILE_OP_DESTINATION_AMBIGUOUS" }
    if (!stat.isDirectory())
      return { canonicalPath: candidate, writable: false, reason: "FILE_OP_TARGET_NOT_DIRECTORY" }
    const permission = await ensureWritableDirectory(candidate)
    if (permission) return { canonicalPath: candidate, writable: false, reason: permission }
    return { canonicalPath: candidate, writable: true }
  }

  export async function upload(input: {
    parent: string
    filename: string
    source: Blob
  }): Promise<OperationResult> {
    return withTelemetry("upload", input as unknown as Record<string, unknown>, async () => {
      const name = validateBasename(input.filename)
      const limit = uploadMaxBytes()
      if (typeof input.source.size === "number" && input.source.size > limit) {
        throw operationError("FILE_UPLOAD_TOO_LARGE", "File is too large to upload.", {
          limit,
          size: input.source.size,
        })
      }
      const parent = await resolveProjectParent(input.parent)
      const destination = path.join(parent, name)
      await assertOperationWithinProject(destination)
      await assertDestinationAvailable(destination)
      const buffer = await input.source.arrayBuffer()
      if (buffer.byteLength > limit) {
        throw operationError("FILE_UPLOAD_TOO_LARGE", "File is too large to upload.", {
          limit,
          size: buffer.byteLength,
        })
      }
      await fs.promises.writeFile(destination, new Uint8Array(buffer), { flag: "wx" }).catch((err) => {
        if (isAlreadyExistsError(err)) {
          throw operationError("FILE_OP_DUPLICATE", "A file or folder with this name already exists.", {
            path: destination,
          })
        }
        throw err
      })
      return {
        operation: "upload",
        destination: normalizeRelative(destination),
        node: await nodeFromPath(destination),
        affectedDirectories: [normalizeRelative(parent)],
      }
    }, operationResultParts)
  }

  export interface DownloadResult {
    absolutePath: string
    relativePath: string
    filename: string
    size: number
    mimeType: string
  }

  export async function download(input: { path: string }): Promise<DownloadResult> {
    return withTelemetry(
      "download",
      input as unknown as Record<string, unknown>,
      async () => {
        const source = await resolveProjectPath(input.path)
        const stat = await assertSourceExists(source)
        if (stat.isDirectory()) {
          throw operationError(
            "FILE_DOWNLOAD_DIRECTORY_UNSUPPORTED",
            "Directory download is not available in this phase.",
            { path: normalizeRelative(source) },
          )
        }
        if (!stat.isFile()) {
          throw operationError("FILE_OP_NOT_FILE", "Operation requires a file, but the target is not a file.", {
            path: normalizeRelative(source),
          })
        }
        const filename = path.basename(source)
        const bunFile = Bun.file(source)
        const mimeType =
          bunFile.type && bunFile.type !== "application/octet-stream"
            ? bunFile.type
            : isImageByExtension(filename)
              ? getImageMimeType(filename)
              : isTextByExtension(filename) || isTextByName(filename)
                ? "text/plain; charset=utf-8"
                : isBinaryByExtension(filename)
                  ? "application/octet-stream"
                  : "application/octet-stream"
        return {
          absolutePath: source,
          relativePath: normalizeRelative(source),
          filename,
          size: stat.size,
          mimeType,
        }
      },
      (result) => ({ source: result.relativePath }),
    )
  }

  export async function search(input: { query: string; limit?: number; dirs?: boolean; type?: "file" | "directory" }) {
    const query = input.query.trim()
    const limit = input.limit ?? 100
    const kind = input.type ?? (input.dirs === false ? "file" : "all")
    log.info("search", { query, kind })

    const result = await state().then((x) => x.files())

    const hidden = (item: string) => {
      const normalized = item.replaceAll("\\", "/").replace(/\/+$/, "")
      return normalized.split("/").some((p) => p.startsWith(".") && p.length > 1)
    }
    const preferHidden = query.startsWith(".") || query.includes("/.")
    const sortHiddenLast = (items: string[]) => {
      if (preferHidden) return items
      const visible: string[] = []
      const hiddenItems: string[] = []
      for (const item of items) {
        const isHidden = hidden(item)
        if (isHidden) hiddenItems.push(item)
        if (!isHidden) visible.push(item)
      }
      return [...visible, ...hiddenItems]
    }
    if (!query) {
      if (kind === "file") {
        await warnIfOutsideProject(result.files, "search:files")
      } else if (kind === "directory") {
        await warnIfOutsideProject(result.dirs, "search:dirs")
      } else {
        await warnIfOutsideProject(result.files, "search:files")
        await warnIfOutsideProject(result.dirs, "search:dirs")
      }
      if (kind === "file") return result.files.slice(0, limit)
      return sortHiddenLast(result.dirs.toSorted()).slice(0, limit)
    }

    if (kind === "file") {
      await warnIfOutsideProject(result.files, "search:files")
    } else if (kind === "directory") {
      await warnIfOutsideProject(result.dirs, "search:dirs")
    } else {
      await warnIfOutsideProject(result.files, "search:files")
      await warnIfOutsideProject(result.dirs, "search:dirs")
    }

    const items =
      kind === "file" ? result.files : kind === "directory" ? result.dirs : [...result.files, ...result.dirs]

    const searchLimit = kind === "directory" && !preferHidden ? limit * 20 : limit
    const sorted = fuzzysort.go(query, items, { limit: searchLimit }).map((r) => r.target)
    const output = kind === "directory" ? sortHiddenLast(sorted).slice(0, limit) : sorted

    log.info("search", { query, kind, results: output.length })
    return output
  }
}
