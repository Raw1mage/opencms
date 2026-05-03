import { BusEvent } from "@/bus/bus-event"
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

  function isWithinRoot(candidate: string, root: string): boolean {
    if (root === path.parse(root).root) return path.isAbsolute(candidate)
    return candidate === root || candidate.startsWith(root + path.sep)
  }

  async function isWithinProject(targetPath: string): Promise<boolean> {
    const root = await getProjectRootReal()
    const resolved = path.resolve(targetPath)
    if (!isWithinRoot(resolved, root)) {
      return false
    }
    const real = await fs.promises.realpath(targetPath).catch(() => undefined)
    if (real && !isWithinRoot(real, root)) {
      return false
    }
    if (!real) {
      const parentReal = await fs.promises.realpath(path.dirname(targetPath)).catch(() => undefined)
      if (parentReal && !isWithinRoot(parentReal, root)) {
        return false
      }
    }
    return true
  }

  async function assertWithinProject(targetPath: string): Promise<string> {
    const root = await getProjectRootReal()
    const resolved = path.resolve(targetPath)
    const globalBrowse = allowGlobalFilesystemBrowse()
    if (!isWithinRoot(resolved, root)) {
      log.warn("assertWithinProject denied (resolved outside root)", {
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
    if (real && !isWithinRoot(real, root)) {
      log.warn("assertWithinProject denied (realpath outside root)", {
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
      if (parentReal && !isWithinRoot(parentReal, root)) {
        log.warn("assertWithinProject denied (parent realpath outside root)", {
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
      dir && allowGlobalFilesystemBrowse() && path.isAbsolute(dir)
        ? dir
        : dir
          ? path.join(Instance.directory, dir)
          : Instance.directory
    const resolved = await assertWithinProject(requested)

    const entries = await fs.promises.readdir(resolved, {
      withFileTypes: true,
    })
    const nodes: Node[] = []
    for (const entry of entries) {
      if (exclude.includes(entry.name)) continue
      const fullPath = path.join(resolved, entry.name)
      const relativePath = path.relative(Instance.directory, fullPath)
      const type = entry.isDirectory() ? "directory" : "file"
      const escapedRelative = relativePath === "" || relativePath === ".." || relativePath.startsWith("../")
      nodes.push({
        name: entry.name,
        path: relativePath,
        absolute: fullPath,
        type,
        ignored: escapedRelative ? false : ignored(type === "directory" ? relativePath + "/" : relativePath),
      })
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }

  export async function createDirectory(input: { path: string }): Promise<DirectoryCreateResult> {
    const requested =
      allowGlobalFilesystemBrowse() && path.isAbsolute(input.path)
        ? input.path
        : path.join(Instance.directory, input.path)
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
