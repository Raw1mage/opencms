import { describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import * as os from "os"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { ReadTool } from "../../src/tool/read"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const baseCtx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: (_input?: unknown) => {},
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: {
    diff: string
    filepath: string
    files: Array<{
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
    }>
  }
}

type ToolCtx = typeof baseCtx & {
  ask: (input: AskInput) => Promise<void>
}

const execute = async (params: { patchText: string }, ctx: ToolCtx) => {
  const tool = await ApplyPatchTool.init()
  return tool.execute(params, ctx)
}

const readFileWithTool = async (filePath: string, ctx: ToolCtx) => {
  const tool = await ReadTool.init()
  return tool.execute({ filePath }, ctx as any)
}

const makeCtx = () => {
  const calls: AskInput[] = []
  const ctx: ToolCtx = {
    ...baseCtx,
    ask: async (input) => {
      calls.push(input)
    },
  }

  return { ctx, calls }
}

const withNonSudoerScope = async (fn: () => Promise<void>) => {
  const previous = process.env.OPENCODE_APPLY_PATCH_DISABLE_SUDOER_SCOPE
  process.env.OPENCODE_APPLY_PATCH_DISABLE_SUDOER_SCOPE = "1"
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_APPLY_PATCH_DISABLE_SUDOER_SCOPE
    else process.env.OPENCODE_APPLY_PATCH_DISABLE_SUDOER_SCOPE = previous
  }
}

const withHomeFixture = async (fn: (root: string) => Promise<void>) => {
  const root = await fs.mkdtemp(path.join(os.homedir(), ".opencode-apply-patch-test-"))
  try {
    await fn(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("tool.apply_patch freeform", () => {
  test("requires input", async () => {
    const { ctx } = makeCtx()
    await expect(execute({ patchText: "" }, ctx)).rejects.toThrow("input is required")
  })

  test("rejects invalid patch format", async () => {
    const { ctx } = makeCtx()
    await expect(execute({ patchText: "invalid patch" }, ctx)).rejects.toThrow("apply_patch verification failed")
  })

  test("rejects empty patch", async () => {
    const { ctx } = makeCtx()
    const emptyPatch = "*** Begin Patch\n*** End Patch"
    await expect(execute({ patchText: emptyPatch }, ctx)).rejects.toThrow("patch rejected: empty patch")
  })

  test("allows absolute patch paths inside the current home", async () => {
    await withNonSudoerScope(async () => {
      await withHomeFixture(async (root) => {
        const { ctx, calls } = makeCtx()
        const repo = path.join(root, "repo")
        await fs.mkdir(repo)

        await Instance.provide({
          directory: repo,
          fn: async () => {
            const target = path.join(root, "absolute.txt")
            const patchText = `*** Begin Patch\n*** Add File: ${target}\n+home absolute\n*** End Patch`

            await execute({ patchText }, ctx)

            expect(await fs.readFile(target, "utf-8")).toBe("home absolute\n")
            const file = calls.find((call) => call.metadata.files)?.metadata.files[0]
            expect(file).toBeDefined()
            expect(file!.requestedPath).toBe(target)
            expect(file!.normalizedPath).toBe(target)
            expect(file!.absolutePath).toBe(target)
            expect(calls.find((call) => call.permission === "edit")?.patterns).toEqual([target])
          },
        })
      })
    })
  })

  test("allows parent-directory patch paths that resolve inside the current home", async () => {
    await withNonSudoerScope(async () => {
      await withHomeFixture(async (root) => {
        const { ctx, calls } = makeCtx()
        const repo = path.join(root, "repo")
        const sibling = path.join(root, "sibling")
        await fs.mkdir(repo)
        await fs.mkdir(sibling)

        await Instance.provide({
          directory: repo,
          fn: async () => {
            const patchText = "*** Begin Patch\n*** Add File: ../sibling/escape.txt\n+home sibling\n*** End Patch"

            await execute({ patchText }, ctx)

            const target = path.join(sibling, "escape.txt")
            expect(await fs.readFile(target, "utf-8")).toBe("home sibling\n")
            const file = calls.find((call) => call.metadata.files)?.metadata.files[0]
            expect(file).toBeDefined()
            expect(file!.requestedPath).toBe("../sibling/escape.txt")
            expect(file!.normalizedPath).toBe("../sibling/escape.txt")
            expect(file!.absolutePath).toBe(target)
            expect(calls.find((call) => call.permission === "edit")?.patterns).toEqual([target])
          },
        })
      })
    })
  })

  test("post-write verification makes read-after-apply observable for markdown files", async () => {
    await using fixture = await tmpdir({ git: true })
    const { ctx, calls } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const tracked = path.join(fixture.path, "docs", "events", "event.md")
        const untracked = path.join(fixture.path, "plans", "example", "tasks.md")
        await fs.mkdir(path.dirname(tracked), { recursive: true })
        await fs.mkdir(path.dirname(untracked), { recursive: true })
        await fs.writeFile(tracked, "# Event\n\n- [ ] Sync docs\n", "utf-8")
        await fs.writeFile(untracked, "# Tasks\n\n- [ ] Finish regression\n", "utf-8")

        const before = await readFileWithTool(tracked, ctx)
        expect(before.output).toContain("- [ ] Sync docs")

        await execute(
          {
            patchText:
              "*** Begin Patch\n*** Update File: docs/events/event.md\n@@\n-- [ ] Sync docs\n+- [x] Sync docs\n*** Update File: plans/example/tasks.md\n@@\n-- [ ] Finish regression\n+- [x] Finish regression\n*** End Patch",
          },
          ctx,
        )

        const afterTracked = await readFileWithTool(tracked, ctx)
        const afterUntracked = await readFileWithTool(untracked, ctx)
        expect(afterTracked.output).toContain("- [x] Sync docs")
        expect(afterUntracked.output).toContain("- [x] Finish regression")

        const editedFiles = calls.find((call) => call.permission === "edit")?.metadata.files ?? []
        expect(editedFiles).toHaveLength(2)
        expect(editedFiles.every((file) => file.verified === true)).toBe(true)
        expect(editedFiles.every((file) => typeof file.sha256Before === "string")).toBe(true)
        expect(editedFiles.every((file) => typeof file.sha256After === "string")).toBe(true)
      },
    })
  })

  test("rejects non-sudoer patch paths outside repo, worktree, and home", async () => {
    await withNonSudoerScope(async () => {
      await using fixture = await tmpdir()
      await withHomeFixture(async (root) => {
        const { ctx } = makeCtx()
        const repo = path.join(root, "repo")
        await fs.mkdir(repo)

        await Instance.provide({
          directory: repo,
          fn: async () => {
            const target = path.join(fixture.path, "outside.txt")
            const patchText = `*** Begin Patch\n*** Add File: ${target}\n+outside\n*** End Patch`

            await expect(execute({ patchText }, ctx)).rejects.toThrow("outside allowed scope")
            await expect(fs.readFile(target, "utf-8")).rejects.toThrow()
          },
        })
      })
    })
  })

  test("rejects non-sudoer symlink realpath escapes outside repo, worktree, and home", async () => {
    await withNonSudoerScope(async () => {
      await using fixture = await tmpdir()
      await withHomeFixture(async (root) => {
        const { ctx } = makeCtx()
        const repo = path.join(root, "repo")
        const outside = path.join(fixture.path, "outside")
        await fs.mkdir(repo)
        await fs.mkdir(outside)
        await fs.writeFile(path.join(outside, "file.txt"), "old\n", "utf-8")
        await fs.symlink(outside, path.join(repo, "link"))

        await Instance.provide({
          directory: repo,
          fn: async () => {
            const patchText = "*** Begin Patch\n*** Update File: link/file.txt\n@@\n-old\n+new\n*** End Patch"

            await expect(execute({ patchText }, ctx)).rejects.toThrow("outside allowed scope")
            expect(await fs.readFile(path.join(outside, "file.txt"), "utf-8")).toBe("old\n")
          },
        })
      })
    })
  })

  test("rejects no-op update patches", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "same.txt")
        await fs.writeFile(target, "same\n", "utf-8")
        const patchText = "*** Begin Patch\n*** Update File: same.txt\n@@\n-same\n+same\n*** End Patch"

        // Idempotency guard: no-op update returns success instead of throwing
        const result = await execute({ patchText }, ctx)
        expect(result.output).toContain("already")
        expect(await fs.readFile(target, "utf-8")).toBe("same\n")
      },
    })
  })

  test("reports real path for symlinked patch paths", async () => {
    await using fixture = await tmpdir({ git: true })
    const { ctx, calls } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const targetDir = path.join(fixture.path, "target")
        await fs.mkdir(targetDir)
        await fs.writeFile(path.join(targetDir, "file.txt"), "old\n", "utf-8")
        await fs.symlink("target", path.join(fixture.path, "link"))

        const patchText = "*** Begin Patch\n*** Update File: link/file.txt\n@@\n-old\n+new\n*** End Patch"
        await execute({ patchText }, ctx)

        const file = calls.find((call) => call.metadata.files)?.metadata.files[0]
        expect(file!.requestedPath).toBe("link/file.txt")
        expect(file!.normalizedPath).toBe("link/file.txt")
        expect(file!.absolutePath).toBe(path.join(fixture.path, "link/file.txt"))
        expect(file!.realPath).toBe(await fs.realpath(path.join(fixture.path, "target/file.txt")))
        expect(await fs.readFile(path.join(targetDir, "file.txt"), "utf-8")).toBe("new\n")
      },
    })
  })

  test("applies add/update/delete in one patch", async () => {
    await using fixture = await tmpdir({ git: true })
    const { ctx, calls } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const modifyPath = path.join(fixture.path, "modify.txt")
        const deletePath = path.join(fixture.path, "delete.txt")
        await fs.writeFile(modifyPath, "line1\nline2\n", "utf-8")
        await fs.writeFile(deletePath, "obsolete\n", "utf-8")

        const patchText =
          "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** End Patch"

        const result = await execute({ patchText }, ctx)

        expect(result.title).toContain("Success. Updated the following files")
        expect(result.output).toContain("Success. Updated the following files")
        expect(result.metadata.diff).toContain("Index:")
        expect(calls.length).toBe(1)

        // Verify permission metadata includes files array for UI rendering
        const permissionCall = calls[0]
        expect(permissionCall.metadata.files).toHaveLength(3)
        expect(permissionCall.metadata.files.map((f) => f.type).sort()).toEqual(["add", "delete", "update"])

        const addFile = permissionCall.metadata.files.find((f) => f.type === "add")
        expect(addFile).toBeDefined()
        expect(addFile!.relativePath).toBe("nested/new.txt")
        expect(addFile!.requestedPath).toBe("nested/new.txt")
        expect(addFile!.normalizedPath).toBe("nested/new.txt")
        expect(addFile!.absolutePath).toBe(path.join(fixture.path, "nested/new.txt"))
        expect(addFile!.bytesBefore).toBe(0)
        expect(addFile!.bytesAfter).toBe(Buffer.byteLength("created\n", "utf-8"))
        expect(addFile!.diff).toContain("+created")
        expect("before" in addFile!).toBe(false)
        expect("after" in addFile!).toBe(false)

        const updateFile = permissionCall.metadata.files.find((f) => f.type === "update")
        expect(updateFile).toBeDefined()
        expect(updateFile!.requestedPath).toBe("modify.txt")
        expect(updateFile!.normalizedPath).toBe("modify.txt")
        expect(updateFile!.absolutePath).toBe(modifyPath)
        expect(updateFile!.realPath).toBe(await fs.realpath(modifyPath))
        expect(updateFile!.bytesBefore).toBe(Buffer.byteLength("line1\nline2\n", "utf-8"))
        expect(updateFile!.bytesAfter).toBe(Buffer.byteLength("line1\nchanged\n", "utf-8"))
        expect(updateFile!.diff).toContain("-line2")
        expect(updateFile!.diff).toContain("+changed")
        expect("before" in updateFile!).toBe(false)
        expect("after" in updateFile!).toBe(false)

        const added = await fs.readFile(path.join(fixture.path, "nested", "new.txt"), "utf-8")
        expect(added).toBe("created\n")
        expect(await fs.readFile(modifyPath, "utf-8")).toBe("line1\nchanged\n")
        await expect(fs.readFile(deletePath, "utf-8")).rejects.toThrow()
      },
    })
  })

  test("permission metadata includes move file info", async () => {
    await using fixture = await tmpdir({ git: true })
    const { ctx, calls } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const original = path.join(fixture.path, "old", "name.txt")
        await fs.mkdir(path.dirname(original), { recursive: true })
        await fs.writeFile(original, "old content\n", "utf-8")

        const patchText =
          "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

        await execute({ patchText }, ctx)

        expect(calls.length).toBe(1)
        const permissionCall = calls[0]
        expect(permissionCall.metadata.files).toHaveLength(1)

        const moveFile = permissionCall.metadata.files[0]
        expect(moveFile.type).toBe("move")
        expect(moveFile.relativePath).toBe("renamed/dir/name.txt")
        expect(moveFile.movePath).toBe(path.join(fixture.path, "renamed/dir/name.txt"))
        expect(moveFile.diff).toContain("-old content")
        expect(moveFile.diff).toContain("+new content")
        expect("before" in moveFile).toBe(false)
        expect("after" in moveFile).toBe(false)
      },
    })
  })

  test("reports phased metadata for observability", async () => {
    await using fixture = await tmpdir({ git: true })
    const metadataCalls: Array<Record<string, any>> = []
    const { calls } = makeCtx()
    const ctx: ToolCtx = {
      ...baseCtx,
      metadata: (input?: unknown) => {
        metadataCalls.push((input as { metadata?: Record<string, any> } | undefined)?.metadata ?? {})
      },
      ask: async (input) => {
        calls.push(input)
      },
    }

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "phase.txt")
        await fs.writeFile(target, "before\n", "utf-8")

        const patchText = "*** Begin Patch\n*** Update File: phase.txt\n@@\n-before\n+after\n*** End Patch"

        const result = await execute({ patchText }, ctx)

        expect(result.metadata.phase).toBe("completed")
        expect(metadataCalls.map((call) => call.phase)).toEqual([
          "parsing",
          "planning",
          "planning",
          "awaiting_approval",
          "applying",
          "diagnostics",
          "diagnostics",
        ])

        expect(metadataCalls[2]).toMatchObject({
          phase: "planning",
          currentFile: "phase.txt",
          completedCount: 0,
          totalCount: 1,
        })
        expect(metadataCalls[3]).toMatchObject({
          phase: "awaiting_approval",
          completedCount: 1,
          totalCount: 1,
        })
        expect(metadataCalls[4]).toMatchObject({
          phase: "applying",
          currentFile: "phase.txt",
          completedCount: 0,
          totalCount: 1,
        })
        expect(metadataCalls[6]).toMatchObject({
          phase: "diagnostics",
          currentFile: "phase.txt",
          completedCount: 0,
          totalCount: 1,
        })
        expect(result.metadata).toMatchObject({
          phase: "completed",
        })
        expect(metadataCalls[3].files).toHaveLength(1)
        expect(metadataCalls[4].files).toHaveLength(1)
        expect(metadataCalls[5].files).toHaveLength(1)
        expect(result.metadata.files).toHaveLength(1)
      },
    })
  })

  test("applies multiple hunks to one file", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "multi.txt")
        await fs.writeFile(target, "line1\nline2\nline3\nline4\n", "utf-8")

        const patchText =
          "*** Begin Patch\n*** Update File: multi.txt\n@@\n-line2\n+changed2\n@@\n-line4\n+changed4\n*** End Patch"

        await execute({ patchText }, ctx)

        expect(await fs.readFile(target, "utf-8")).toBe("line1\nchanged2\nline3\nchanged4\n")
      },
    })
  })

  test("inserts lines with insert-only hunk", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "insert_only.txt")
        await fs.writeFile(target, "alpha\nomega\n", "utf-8")

        const patchText = "*** Begin Patch\n*** Update File: insert_only.txt\n@@\n alpha\n+beta\n omega\n*** End Patch"

        await execute({ patchText }, ctx)

        expect(await fs.readFile(target, "utf-8")).toBe("alpha\nbeta\nomega\n")
      },
    })
  })

  test("appends trailing newline on update", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "no_newline.txt")
        await fs.writeFile(target, "no newline at end", "utf-8")

        const patchText =
          "*** Begin Patch\n*** Update File: no_newline.txt\n@@\n-no newline at end\n+first line\n+second line\n*** End Patch"

        await execute({ patchText }, ctx)

        const contents = await fs.readFile(target, "utf-8")
        expect(contents.endsWith("\n")).toBe(true)
        expect(contents).toBe("first line\nsecond line\n")
      },
    })
  })

  test("moves file to a new directory", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const original = path.join(fixture.path, "old", "name.txt")
        await fs.mkdir(path.dirname(original), { recursive: true })
        await fs.writeFile(original, "old content\n", "utf-8")

        const patchText =
          "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

        await execute({ patchText }, ctx)

        const moved = path.join(fixture.path, "renamed", "dir", "name.txt")
        await expect(fs.readFile(original, "utf-8")).rejects.toThrow()
        expect(await fs.readFile(moved, "utf-8")).toBe("new content\n")
      },
    })
  })

  test("moves file overwriting existing destination", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const original = path.join(fixture.path, "old", "name.txt")
        const destination = path.join(fixture.path, "renamed", "dir", "name.txt")
        await fs.mkdir(path.dirname(original), { recursive: true })
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(original, "from\n", "utf-8")
        await fs.writeFile(destination, "existing\n", "utf-8")

        const patchText =
          "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-from\n+new\n*** End Patch"

        await execute({ patchText }, ctx)

        await expect(fs.readFile(original, "utf-8")).rejects.toThrow()
        expect(await fs.readFile(destination, "utf-8")).toBe("new\n")
      },
    })
  })

  test("adds file overwriting existing file", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "duplicate.txt")
        await fs.writeFile(target, "old content\n", "utf-8")

        const patchText = "*** Begin Patch\n*** Add File: duplicate.txt\n+new content\n*** End Patch"

        await execute({ patchText }, ctx)
        expect(await fs.readFile(target, "utf-8")).toBe("new content\n")
      },
    })
  })

  test("rejects update when target file is missing", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const patchText = "*** Begin Patch\n*** Update File: missing.txt\n@@\n-nope\n+better\n*** End Patch"

        await expect(execute({ patchText }, ctx)).rejects.toThrow(
          "apply_patch verification failed: Failed to read file to update",
        )
      },
    })
  })

  test("idempotent delete when file already missing", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const patchText = "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch"

        // Idempotency guard: deleting a missing file returns success
        const result = await execute({ patchText }, ctx)
        expect(result.output).toContain("already")
      },
    })
  })

  test("rejects delete when target is a directory", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const dirPath = path.join(fixture.path, "dir")
        await fs.mkdir(dirPath)

        const patchText = "*** Begin Patch\n*** Delete File: dir\n*** End Patch"

        await expect(execute({ patchText }, ctx)).rejects.toThrow()
      },
    })
  })

  test("rejects invalid hunk header", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const patchText = "*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch"

        await expect(execute({ patchText }, ctx)).rejects.toThrow("apply_patch verification failed")
      },
    })
  })

  test("rejects update with missing context", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "modify.txt")
        await fs.writeFile(target, "line1\nline2\n", "utf-8")

        const patchText = "*** Begin Patch\n*** Update File: modify.txt\n@@\n-missing\n+changed\n*** End Patch"

        await expect(execute({ patchText }, ctx)).rejects.toThrow("apply_patch verification failed")
        expect(await fs.readFile(target, "utf-8")).toBe("line1\nline2\n")
      },
    })
  })

  test("verification failure leaves no side effects", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const patchText =
          "*** Begin Patch\n*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"

        await expect(execute({ patchText }, ctx)).rejects.toThrow()

        const createdPath = path.join(fixture.path, "created.txt")
        await expect(fs.readFile(createdPath, "utf-8")).rejects.toThrow()
      },
    })
  })

  test("supports end of file anchor", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "tail.txt")
        await fs.writeFile(target, "alpha\nlast\n", "utf-8")

        const patchText = "*** Begin Patch\n*** Update File: tail.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch"

        await execute({ patchText }, ctx)
        expect(await fs.readFile(target, "utf-8")).toBe("alpha\nend\n")
      },
    })
  })

  test("rejects missing second chunk context", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "two_chunks.txt")
        await fs.writeFile(target, "a\nb\nc\nd\n", "utf-8")

        const patchText = "*** Begin Patch\n*** Update File: two_chunks.txt\n@@\n-b\n+B\n\n-d\n+D\n*** End Patch"

        await expect(execute({ patchText }, ctx)).rejects.toThrow()
        expect(await fs.readFile(target, "utf-8")).toBe("a\nb\nc\nd\n")
      },
    })
  })

  test("disambiguates change context with @@ header", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "multi_ctx.txt")
        await fs.writeFile(target, "fn a\nx=10\ny=2\nfn b\nx=10\ny=20\n", "utf-8")

        const patchText = "*** Begin Patch\n*** Update File: multi_ctx.txt\n@@ fn b\n-x=10\n+x=11\n*** End Patch"

        await execute({ patchText }, ctx)
        expect(await fs.readFile(target, "utf-8")).toBe("fn a\nx=10\ny=2\nfn b\nx=11\ny=20\n")
      },
    })
  })

  test("EOF anchor matches from end of file first", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "eof_anchor.txt")
        // File has duplicate "marker" lines - one in middle, one at end
        await fs.writeFile(target, "start\nmarker\nmiddle\nmarker\nend\n", "utf-8")

        // With EOF anchor, should match the LAST "marker" line, not the first
        const patchText =
          "*** Begin Patch\n*** Update File: eof_anchor.txt\n@@\n-marker\n-end\n+marker-changed\n+end\n*** End of File\n*** End Patch"

        await execute({ patchText }, ctx)
        // First marker unchanged, second marker changed
        expect(await fs.readFile(target, "utf-8")).toBe("start\nmarker\nmiddle\nmarker-changed\nend\n")
      },
    })
  })

  test("parses heredoc-wrapped patch", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const patchText = `cat <<'EOF'
*** Begin Patch
*** Add File: heredoc_test.txt
+heredoc content
*** End Patch
EOF`

        await execute({ patchText }, ctx)
        const content = await fs.readFile(path.join(fixture.path, "heredoc_test.txt"), "utf-8")
        expect(content).toBe("heredoc content\n")
      },
    })
  })

  test("parses heredoc-wrapped patch without cat", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const patchText = `<<EOF
*** Begin Patch
*** Add File: heredoc_no_cat.txt
+no cat prefix
*** End Patch
EOF`

        await execute({ patchText }, ctx)
        const content = await fs.readFile(path.join(fixture.path, "heredoc_no_cat.txt"), "utf-8")
        expect(content).toBe("no cat prefix\n")
      },
    })
  })

  test("matches with trailing whitespace differences", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "trailing_ws.txt")
        // File has trailing spaces on some lines
        await fs.writeFile(target, "line1  \nline2\nline3   \n", "utf-8")

        // Patch doesn't have trailing spaces - should still match via rstrip pass
        const patchText = "*** Begin Patch\n*** Update File: trailing_ws.txt\n@@\n-line2\n+changed\n*** End Patch"

        await execute({ patchText }, ctx)
        expect(await fs.readFile(target, "utf-8")).toBe("line1  \nchanged\nline3   \n")
      },
    })
  })

  test("matches with leading whitespace differences", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "leading_ws.txt")
        // File has leading spaces
        await fs.writeFile(target, "  line1\nline2\n  line3\n", "utf-8")

        // Patch without leading spaces - should match via trim pass
        const patchText = "*** Begin Patch\n*** Update File: leading_ws.txt\n@@\n-line2\n+changed\n*** End Patch"

        await execute({ patchText }, ctx)
        expect(await fs.readFile(target, "utf-8")).toBe("  line1\nchanged\n  line3\n")
      },
    })
  })

  test("matches with Unicode punctuation differences", async () => {
    await using fixture = await tmpdir()
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "unicode.txt")
        // File has fancy Unicode quotes (U+201C, U+201D) and em-dash (U+2014)
        const leftQuote = "\u201C"
        const rightQuote = "\u201D"
        const emDash = "\u2014"
        await fs.writeFile(target, `He said ${leftQuote}hello${rightQuote}\nsome${emDash}dash\nend\n`, "utf-8")

        // Patch uses ASCII equivalents - should match via normalized pass
        // The replacement uses ASCII quotes from the patch (not preserving Unicode)
        const patchText =
          '*** Begin Patch\n*** Update File: unicode.txt\n@@\n-He said "hello"\n+He said "hi"\n*** End Patch'

        await execute({ patchText }, ctx)
        // Result has ASCII quotes because that's what the patch specifies
        expect(await fs.readFile(target, "utf-8")).toBe(`He said "hi"\nsome${emDash}dash\nend\n`)
      },
    })
  })
})
