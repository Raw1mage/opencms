import crypto from "crypto"
import z from "zod"
import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"
import { Tool } from "./tool"
import { ToolBudget } from "./budget"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectory } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "../lsp"
import { Filesystem } from "../util/filesystem"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"

export type ApplyPatchPhase =
  | "parsing"
  | "planning"
  | "awaiting_approval"
  | "applying"
  | "diagnostics"
  | "failed"
  | "completed"

export type ApplyPatchFileMetadata = {
  filePath: string
  relativePath: string
  requestedPath: string
  normalizedPath: string
  absolutePath: string
  realPath?: string
  type: "add" | "update" | "delete" | "move"
  diff: string
  additions: number
  deletions: number
  bytesBefore: number
  bytesAfter: number
  sha256Before?: string
  sha256After?: string
  verified?: boolean
  movePath?: string
  requestedMovePath?: string
  normalizedMovePath?: string
  absoluteMovePath?: string
  realMovePath?: string
}

export type ApplyPatchMetadata = {
  phase: ApplyPatchPhase
  currentFile?: string
  completedCount?: number
  totalCount?: number
  diff?: string
  files?: ApplyPatchFileMetadata[]
  diagnostics?: Awaited<ReturnType<typeof LSP.diagnostics>>
  error?: string
}

// Match codex-rs canonical schema: parameter name is "input"
// (see refs/codex/codex-rs/core/src/tools/handlers/apply_patch.rs create_apply_patch_json_tool)
const PatchParams = z
  .object({
    input: z.string().optional().describe("The entire contents of the apply_patch command"),
    // Legacy opencode parameter name — kept for backward compatibility
    patchText: z.string().optional(),
  })
  .passthrough()

/**
 * Resolve the actual patch text from params, trying codex-rs canonical
 * name first ("input"), then legacy opencode name ("patchText"), then
 * any single string value as last resort.
 */
function resolvePatchText(params: Record<string, unknown>): string | undefined {
  // codex-rs canonical name
  if (typeof params.input === "string" && params.input) return params.input
  // Legacy opencode name
  if (typeof params.patchText === "string" && params.patchText) return params.patchText
  // Last resort: if there's exactly one string value in the object, use it
  const stringValues = Object.values(params).filter((v): v is string => typeof v === "string" && v.length > 0)
  if (stringValues.length === 1) return stringValues[0]
  return undefined
}

const DISABLE_SUDOER_SCOPE_ENV = "OPENCODE_APPLY_PATCH_DISABLE_SUDOER_SCOPE"
const SUDOER_GROUPS = new Set(["sudo", "wheel", "admin"])

function containsPath(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizedDisplayPath(input: string, absolutePath: string) {
  if (path.isAbsolute(input)) return path.normalize(absolutePath).replaceAll("\\", "/")
  return path.posix.normalize(input.replaceAll("\\", "/"))
}

async function isSystemScopeAllowed() {
  if (process.env[DISABLE_SUDOER_SCOPE_ENV] === "1") return false
  if (process.getuid?.() === 0) return true

  let username = ""
  let primaryGid: number | undefined
  try {
    const user = os.userInfo()
    username = user.username
    primaryGid = user.gid
  } catch {}

  const gids = new Set<number>()
  if (primaryGid !== undefined) gids.add(primaryGid)
  try {
    for (const gid of process.getgroups?.() ?? []) gids.add(gid)
  } catch {}

  try {
    const groupFile = await fs.readFile("/etc/group", "utf-8")
    for (const line of groupFile.split("\n")) {
      const [name, , gidText, usersText = ""] = line.split(":")
      if (!SUDOER_GROUPS.has(name)) continue
      const gid = Number(gidText)
      const users = usersText.split(",").filter(Boolean)
      if (gids.has(gid) || (!!username && users.includes(username))) return true
    }
  } catch {}

  return false
}

async function allowedRoots() {
  const roots = [Instance.directory]
  if (Instance.worktree !== "/") roots.push(Instance.worktree)
  const home = os.homedir()
  if (home) roots.push(home)

  const result = new Set<string>()
  for (const root of roots) {
    const resolved = path.resolve(root)
    result.add(resolved)
    const real = await fs.realpath(resolved).catch(() => undefined)
    if (real) result.add(real)
  }
  return [...result]
}

async function realpathOrUndefined(filePath: string) {
  return fs.realpath(filePath).catch(() => undefined)
}

function sha256(content: string) {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex")
}

async function verifyWrittenContent(filePath: string, expected: string) {
  const actual = await fs.readFile(filePath, "utf-8").catch((error) => {
    throw new Error(`apply_patch post-write verification failed: ${filePath}: ${error}`)
  })
  if (actual !== expected) {
    throw new Error(
      `apply_patch post-write verification failed: ${filePath}: expected ${Buffer.byteLength(expected, "utf-8")} bytes, read back ${Buffer.byteLength(actual, "utf-8")} bytes`,
    )
  }
}

async function verifyDeleted(filePath: string) {
  const exists = await fs.stat(filePath).then(
    () => true,
    () => false,
  )
  if (exists) throw new Error(`apply_patch post-write verification failed: delete did not remove file: ${filePath}`)
}

async function resolvedTargetPath(filePath: string) {
  const realFile = await realpathOrUndefined(filePath)
  if (realFile) return realFile

  let current = path.dirname(filePath)
  const tail = [path.basename(filePath)]
  while (true) {
    const realParent = await realpathOrUndefined(current)
    if (realParent) return path.join(realParent, ...tail)
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(filePath)
    tail.unshift(path.basename(current))
    current = parent
  }
}

async function assertPatchPathAllowed(filePath: string, label: string) {
  if (await isSystemScopeAllowed()) return

  const target = await resolvedTargetPath(filePath)
  const roots = await allowedRoots()
  if (roots.some((root) => containsPath(root, filePath) && containsPath(root, target))) return

  throw new Error(
    `apply_patch verification failed: ${label} resolves outside allowed scope (repo/worktree/home): ${filePath}`,
  )
}

/**
 * Returns the subset of `paths` that git considers ignored. Resolution
 * is per-worktree (where git is configured); paths outside any git
 * worktree return false. Single batch invocation via `git check-ignore
 * --stdin` to keep overhead bounded for multi-file patches.
 *
 * Used by apply_patch summary to flag gitignored writes so the model
 * doesn't run `git status` to verify and conclude the write failed.
 */
async function detectGitignored(paths: string[]): Promise<Set<string>> {
  const result = new Set<string>()
  if (paths.length === 0) return result
  try {
    const proc = Bun.spawn(["git", "check-ignore", "--stdin", "-z"], {
      cwd: Instance.worktree,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    proc.stdin.write(paths.join("\0") + "\0")
    await proc.stdin.end()
    const out = await new Response(proc.stdout).text()
    await proc.exited
    // git check-ignore exits 0 if any path ignored, 1 if none, 128 on error.
    // -z output is NUL-separated absolute/relative paths matching input.
    if (proc.exitCode === 0 || proc.exitCode === 1) {
      for (const line of out.split("\0")) {
        if (!line) continue
        const abs = path.isAbsolute(line) ? line : path.resolve(Instance.worktree, line)
        result.add(abs)
      }
    }
  } catch {
    // Not in a git worktree, git not installed, etc. — treat as nothing
    // ignored. Hint is purely advisory; absence is harmless.
  }
  return result
}

async function resolvePatchPath(input: string, label: string) {
  if (!input) throw new Error(`apply_patch verification failed: ${label} is empty`)
  if (input.includes("\0")) throw new Error(`apply_patch verification failed: ${label} contains NUL byte: ${input}`)

  const filePath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(Instance.directory, input)
  const normalizedPath = normalizedDisplayPath(input, filePath)
  if (!normalizedPath || normalizedPath === ".") throw new Error(`apply_patch verification failed: ${label} is empty`)
  await assertPatchPathAllowed(filePath, label)
  return { filePath, normalizedPath }
}

export const ApplyPatchTool = Tool.define("apply_patch", {
  description: DESCRIPTION,
  parameters: PatchParams,
  async execute(params, ctx) {
    const reportMetadata = (input: { title?: string; metadata?: ApplyPatchMetadata }) => ctx.metadata(input)

    try {
      const resolvedPatchText = resolvePatchText(params as Record<string, unknown>)
      if (!resolvedPatchText) {
        throw new Error('input is required. Call as: apply_patch({ input: "*** Begin Patch\\n...\\n*** End Patch" })')
      }
      // Normalize: write back so downstream code (e.g. owned-diff) can find it
      ;(params as any).input = resolvedPatchText
      ;(params as any).patchText = resolvedPatchText

      reportMetadata({
        metadata: {
          phase: "parsing",
        },
      })

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(resolvedPatchText)
        hunks = parseResult.hunks
      } catch (error) {
        throw new Error(`apply_patch verification failed: ${error}`)
      }

      if (hunks.length === 0) {
        const normalized = resolvedPatchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          throw new Error("patch rejected: empty patch")
        }
        throw new Error("apply_patch verification failed: no hunks found")
      }

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        requestedPath: string
        normalizedPath: string
        realPath?: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        requestedMovePath?: string
        normalizedMovePath?: string
        realMovePath?: string
        diff: string
        additions: number
        deletions: number
        bytesBefore: number
        bytesAfter: number
      }> = []

      let totalDiff = ""
      let idempotentSkips = 0
      reportMetadata({
        metadata: {
          phase: "planning",
          completedCount: 0,
          totalCount: hunks.length,
        },
      })

      for (const [index, hunk] of hunks.entries()) {
        const { filePath, normalizedPath } = await resolvePatchPath(hunk.path, "file path")
        reportMetadata({
          metadata: {
            phase: "planning",
            currentFile: path.relative(Instance.worktree, filePath).replaceAll("\\", "/"),
            completedCount: index,
            totalCount: hunks.length,
          },
        })
        await assertExternalDirectory(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const oldContent = await fs.readFile(filePath, "utf-8").catch(() => "")
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            if (oldContent === newContent) {
              idempotentSkips++
              continue
            }
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              requestedPath: hunk.path,
              normalizedPath,
              realPath: await realpathOrUndefined(filePath),
              oldContent,
              newContent,
              type: "add",
              diff,
              additions,
              deletions,
              bytesBefore: Buffer.byteLength(oldContent, "utf-8"),
              bytesAfter: Buffer.byteLength(newContent, "utf-8"),
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = await fs.stat(filePath).catch(() => null)
            if (!stats || stats.isDirectory()) {
              throw new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`)
            }

            const oldContent = await fs.readFile(filePath, "utf-8")
            let newContent = oldContent

            // Apply the update chunks to get new content
            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks)
              newContent = fileUpdate.content
            } catch (error) {
              // Idempotency guard: if old_lines can't be found but all
              // new_lines are already in the file, the patch was already
              // applied (common after rotation/compaction replay).
              if (Patch.isChunksAlreadyApplied(filePath, hunk.chunks)) {
                idempotentSkips++
                continue
              }
              throw new Error(`apply_patch verification failed: ${error}`)
            }

            if (!hunk.move_path && oldContent === newContent) {
              // deriveNewContentsFromChunks succeeded but produced identical
              // content — patch is a no-op on this file.
              idempotentSkips++
              continue
            }

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const resolvedMovePath = hunk.move_path ? await resolvePatchPath(hunk.move_path, "move path") : undefined
            const normalizedMovePath = resolvedMovePath?.normalizedPath
            const movePath = resolvedMovePath?.filePath
            await assertExternalDirectory(ctx, movePath)

            fileChanges.push({
              filePath,
              requestedPath: hunk.path,
              normalizedPath,
              realPath: await realpathOrUndefined(filePath),
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              requestedMovePath: hunk.move_path,
              normalizedMovePath,
              realMovePath: movePath ? await realpathOrUndefined(movePath) : undefined,
              diff,
              additions,
              deletions,
              bytesBefore: Buffer.byteLength(oldContent, "utf-8"),
              bytesAfter: Buffer.byteLength(newContent, "utf-8"),
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const deleteExists = await fs.stat(filePath).catch(() => null)
            if (!deleteExists) {
              // File already gone — idempotent skip
              idempotentSkips++
              continue
            }
            const contentToDelete = await fs.readFile(filePath, "utf-8").catch((error) => {
              throw new Error(`apply_patch verification failed: ${error}`)
            })
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              requestedPath: hunk.path,
              normalizedPath,
              realPath: await realpathOrUndefined(filePath),
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bytesBefore: Buffer.byteLength(contentToDelete, "utf-8"),
              bytesAfter: 0,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Idempotency short-circuit: all hunks were already applied.
      // Return a clean success so the AI doesn't retry with a different approach.
      if (idempotentSkips > 0 && fileChanges.length === 0) {
        const msg =
          idempotentSkips === 1
            ? "Patch already applied — file already contains the expected content. No changes made."
            : `All ${idempotentSkips} file(s) already contain the patched content — no changes made.`
        reportMetadata({
          metadata: {
            phase: "completed",
            completedCount: idempotentSkips,
            totalCount: idempotentSkips,
            files: [],
          },
        })
        return {
          title: "apply_patch (idempotent)",
          output: msg,
          metadata: {
            phase: "completed" as const,
            diff: "",
            files: [] as ApplyPatchFileMetadata[],
            diagnostics: {} as Awaited<ReturnType<typeof LSP.diagnostics>>,
          },
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result).
      // Note: before/after full-file bodies were dropped (2026-05-12, plan
      // provider_apply-patch-metadata-strip) — UI renders the unified `diff`
      // hunks directly via @pierre/diffs' patch path. Git snapshot is the
      // authoritative source for full-content history.
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        requestedPath: change.requestedPath,
        normalizedPath: change.normalizedPath,
        absolutePath: change.filePath,
        realPath: change.realPath,
        type: change.type,
        diff: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        bytesBefore: change.bytesBefore,
        bytesAfter: change.bytesAfter,
        sha256Before: sha256(change.oldContent),
        sha256After: sha256(change.newContent),
        verified: false,
        movePath: change.movePath,
        requestedMovePath: change.requestedMovePath,
        normalizedMovePath: change.normalizedMovePath,
        absoluteMovePath: change.movePath,
        realMovePath: change.realMovePath,
      }))

      // Check permissions if needed. Keep in-worktree paths relative for existing
      // approvals, but use absolute paths for home/global patches so the
      // permission layer does not see opaque ../other-repo escapes.
      const permissionPaths = fileChanges.map((c) => {
        const relative = path.relative(Instance.worktree, c.filePath).replaceAll("\\", "/")
        if (!relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative)) return relative
        return c.filePath.replaceAll("\\", "/")
      })
      reportMetadata({
        metadata: {
          phase: "awaiting_approval",
          completedCount: fileChanges.length,
          totalCount: fileChanges.length,
          files,
        },
      })
      await ctx.ask({
        permission: "edit",
        patterns: permissionPaths,
        always: ["*"],
        metadata: {
          filepath: permissionPaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      // Apply the changes
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

      for (const [index, change] of fileChanges.entries()) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        reportMetadata({
          metadata: {
            phase: "applying",
            currentFile: path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
            completedCount: index,
            totalCount: fileChanges.length,
            files,
          },
        })
        switch (change.type) {
          case "add":
            // Create parent directories (recursive: true is safe on existing/root dirs)
            await fs.mkdir(path.dirname(change.filePath), { recursive: true })
            await fs.writeFile(change.filePath, change.newContent, "utf-8")
            await verifyWrittenContent(change.filePath, change.newContent)
            files[index].verified = true
            updates.push({ file: change.filePath, event: "add" })
            break

          case "update":
            await fs.writeFile(change.filePath, change.newContent, "utf-8")
            await verifyWrittenContent(change.filePath, change.newContent)
            files[index].verified = true
            updates.push({ file: change.filePath, event: "change" })
            break

          case "move":
            if (change.movePath) {
              // Create parent directories (recursive: true is safe on existing/root dirs)
              await fs.mkdir(path.dirname(change.movePath), { recursive: true })
              await fs.writeFile(change.movePath, change.newContent, "utf-8")
              await fs.unlink(change.filePath)
              await verifyWrittenContent(change.movePath, change.newContent)
              await verifyDeleted(change.filePath)
              files[index].verified = true
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break

          case "delete":
            await fs.unlink(change.filePath)
            await verifyDeleted(change.filePath)
            files[index].verified = true
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        if (edited) {
          await Bus.publish(File.Event.Edited, {
            file: edited,
          })
        }
      }

      // Publish file change events
      for (const update of updates) {
        await Bus.publish(FileWatcher.Event.Updated, update)
      }

      // Notify LSP of file changes and collect diagnostics
      reportMetadata({
        metadata: {
          phase: "diagnostics",
          completedCount: 0,
          totalCount: fileChanges.length,
          files,
        },
      })
      for (const [index, change] of fileChanges.entries()) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        reportMetadata({
          metadata: {
            phase: "diagnostics",
            currentFile: path.relative(Instance.worktree, target).replaceAll("\\", "/"),
            completedCount: index,
            totalCount: fileChanges.length,
            files,
          },
        })
        await LSP.touchFile(target, true)
      }
      const diagnostics = await LSP.diagnostics()

      // Generate output summary. Mark gitignored paths so the model
      // doesn't waste a turn running `git status` to verify and then
      // concluding "apply_patch lied" when the file legitimately doesn't
      // show up (2026-05-26 warroom RCA — coherent-but-confused loop).
      const gitignoredPaths = await detectGitignored(
        fileChanges.map((change) => change.movePath ?? change.filePath),
      )
      const summaryLines = fileChanges.map((change) => {
        const target = change.type === "delete" ? change.filePath : (change.movePath ?? change.filePath)
        const rel = path.relative(Instance.worktree, target).replaceAll("\\", "/")
        const marker = change.type === "add" ? "A" : change.type === "delete" ? "D" : "M"
        const ignored = gitignoredPaths.has(target) ? " (gitignored — not in `git status`)" : ""
        return `${marker} ${rel}${ignored}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`
      if (gitignoredPaths.size > 0) {
        output += `\n\n[hint: gitignored paths above WILL be on disk; verify via \`read\`, not \`git status\`.]`
      }

      // Report LSP errors for changed files
      const MAX_DIAGNOSTICS_PER_FILE = 20
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const normalized = Filesystem.normalizePath(target)
        const issues = diagnostics[normalized] ?? []
        const errors = issues.filter((item) => item.severity === 1)
        if (errors.length > 0) {
          const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
          const suffix =
            errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
          output += `\n\nLSP errors detected in ${path.relative(Instance.worktree, target).replaceAll("\\", "/")}, please fix:\n<diagnostics file="${target}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
        }
      }

      // Layer 2 (specs/tool-output-chunking/, DD-2): bound the patch
      // summary + LSP errors. The MAX_DIAGNOSTICS_PER_FILE cap above
      // (20 errors per file) makes oversize rare; this token check
      // catches pathological cases (many files × many errors). INV-8:
      // byte-identical when natural output fits.
      const budget = ToolBudget.resolve(ctx, "apply_patch")
      let outOut = output
      if (ToolBudget.estimateTokens(outOut) > budget.tokens) {
        const targetChars = budget.tokens * 4
        const head = outOut.slice(0, Math.max(0, targetChars - 256))
        outOut =
          head +
          `\n\n[apply_patch summary bounded at ~${budget.tokens} tokens by Layer 2 ` +
          `(${budget.source}). LSP errors omitted from tail; inspect the listed files directly to see remaining diagnostics.]`
      }

      return {
        title: output,
        metadata: {
          phase: "completed" as const,
          diff: totalDiff,
          files,
          diagnostics,
        },
        output: outOut,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      reportMetadata({
        metadata: {
          phase: "failed",
          error: msg,
        },
      })
      throw error
    }
  },
})
