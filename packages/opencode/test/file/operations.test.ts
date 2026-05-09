import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { File } from "../../src/file"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

async function expectOperationCode(input: Promise<unknown>, code: File.OperationCode) {
  await expect(input).rejects.toMatchObject({ code })
}

type CapturedEvent = { type: string; properties: Record<string, unknown> }

function captureFileEvents(): { stop: () => void; events: CapturedEvent[] } {
  const events: CapturedEvent[] = []
  const unsubs = [
    Bus.subscribe(File.Event.OperationRequested, (e) =>
      events.push({ type: e.type, properties: e.properties as Record<string, unknown> }),
    ),
    Bus.subscribe(File.Event.OperationCompleted, (e) =>
      events.push({ type: e.type, properties: e.properties as Record<string, unknown> }),
    ),
    Bus.subscribe(File.Event.OperationRejected, (e) =>
      events.push({ type: e.type, properties: e.properties as Record<string, unknown> }),
    ),
  ]
  return {
    events,
    stop: () => {
      for (const u of unsubs) u()
    },
  }
}

async function flushPendingPublishes() {
  // Bus.publish is fired-and-forgotten inside File.* via .catch; yield twice
  // to let pending microtasks deliver to subscribers.
  await Promise.resolve()
  await Promise.resolve()
}

describe("File operation guards", () => {
  test("creates files and rejects duplicate destinations", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await File.create({ parent: ".", name: "notes.txt", type: "file" })

        expect(created.operation).toBe("create-file")
        expect(created.destination).toBe("notes.txt")
        await expectOperationCode(File.create({ parent: ".", name: "notes.txt", type: "file" }), "FILE_OP_DUPLICATE")
      },
    })
  })

  test("rejects mutation path traversal outside active project", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expectOperationCode(
          File.rename({ path: "../../../etc/passwd", name: "passwd.txt" }),
          "FILE_OP_PATH_ESCAPE",
        )
      },
    })
  })

  test("active-project destination preflight stays strict when global browsing is enabled", async () => {
    await using tmp = await tmpdir()
    const previous = process.env.OPENCODE_ALLOW_GLOBAL_FS_BROWSE
    process.env.OPENCODE_ALLOW_GLOBAL_FS_BROWSE = "1"

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.destinationPreflight({ destinationParent: "../../..", scope: "active-project" })

          expect(result.writable).toBe(false)
          expect(result.reason).toBe("FILE_OP_PATH_ESCAPE")
        },
      })
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_ALLOW_GLOBAL_FS_BROWSE
      else process.env.OPENCODE_ALLOW_GLOBAL_FS_BROWSE = previous
    }
  })

  test("moves deleted files to recyclebin with restore metadata", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "draft.txt"), "draft")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const deleted = await File.deleteToRecyclebin({ path: "docs/draft.txt", confirmed: true })
        const tombstone = path.join(tmp.path, deleted.destination!)
        const metadataPath = tombstone + ".opencode-recycle.json"

        expect(deleted.operation).toBe("delete-to-recyclebin")
        await expect(Bun.file(path.join(tmp.path, "docs", "draft.txt")).exists()).resolves.toBe(false)
        await expect(Bun.file(tombstone).exists()).resolves.toBe(true)

        const metadata = await Bun.file(metadataPath).json()
        expect(metadata).toMatchObject({
          originalPath: "docs/draft.txt",
          tombstonePath: deleted.destination,
          type: "file",
        })

        const restored = await File.restoreFromRecyclebin({ tombstonePath: deleted.destination! })

        expect(restored.operation).toBe("restore-from-recyclebin")
        await expect(Bun.file(path.join(tmp.path, "docs", "draft.txt")).text()).resolves.toBe("draft")
        await expect(Bun.file(metadataPath).exists()).resolves.toBe(false)
      },
    })
  })

  test("restore rejects conflicts at the original destination", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "draft.txt"), "draft")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const deleted = await File.deleteToRecyclebin({ path: "docs/draft.txt", confirmed: true })
        await fs.writeFile(path.join(tmp.path, "docs", "draft.txt"), "replacement")

        await expectOperationCode(
          File.restoreFromRecyclebin({ tombstonePath: deleted.destination! }),
          "FILE_RECYCLEBIN_RESTORE_CONFLICT",
        )
      },
    })
  })

  test("uploads a new file into an active-project directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.upload({
          parent: "docs",
          filename: "sample.txt",
          source: new Blob(["hello"], { type: "text/plain" }),
        })

        expect(result.operation).toBe("upload")
        expect(result.destination).toBe("docs/sample.txt")
        expect(result.affectedDirectories).toContain("docs")
        await expect(Bun.file(path.join(tmp.path, "docs", "sample.txt")).text()).resolves.toBe("hello")
      },
    })
  })

  test("upload rejects duplicate destinations", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "sample.txt"), "existing")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expectOperationCode(
          File.upload({
            parent: "docs",
            filename: "sample.txt",
            source: new Blob(["new"], { type: "text/plain" }),
          }),
          "FILE_OP_DUPLICATE",
        )
        // Existing bytes preserved.
        await expect(Bun.file(path.join(tmp.path, "docs", "sample.txt")).text()).resolves.toBe("existing")
      },
    })
  })

  test("upload rejects oversize payloads (env-tunable cap)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
      },
    })
    const previous = process.env.OPENCODE_FILE_UPLOAD_MAX_BYTES
    process.env.OPENCODE_FILE_UPLOAD_MAX_BYTES = "8"

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expectOperationCode(
            File.upload({
              parent: "docs",
              filename: "big.bin",
              source: new Blob(["123456789"], { type: "application/octet-stream" }),
            }),
            "FILE_UPLOAD_TOO_LARGE",
          )
          // No partial bytes left on disk.
          await expect(Bun.file(path.join(tmp.path, "docs", "big.bin")).exists()).resolves.toBe(false)
        },
      })
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_FILE_UPLOAD_MAX_BYTES
      else process.env.OPENCODE_FILE_UPLOAD_MAX_BYTES = previous
    }
  })

  test("upload rejects parent that escapes the active project", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expectOperationCode(
          File.upload({
            parent: "../outside",
            filename: "x.txt",
            source: new Blob(["x"]),
          }),
          "FILE_OP_PATH_ESCAPE",
        )
      },
    })
  })

  test("upload rejects filename containing path separators", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expectOperationCode(
          File.upload({
            parent: ".",
            filename: "../boom.txt",
            source: new Blob(["x"]),
          }),
          "FILE_OP_INVALID_NAME",
        )
      },
    })
  })

  test("downloads file metadata for an existing project file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "a.txt"), "hello")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.download({ path: "docs/a.txt" })
        expect(result.relativePath).toBe("docs/a.txt")
        expect(result.filename).toBe("a.txt")
        expect(result.size).toBe(5)
        expect(result.mimeType.startsWith("text/")).toBe(true)
      },
    })
  })

  test("download rejects directory targets", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expectOperationCode(File.download({ path: "docs" }), "FILE_DOWNLOAD_DIRECTORY_UNSUPPORTED")
      },
    })
  })

  test("download rejects missing source", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expectOperationCode(File.download({ path: "ghost.txt" }), "FILE_OP_SOURCE_NOT_FOUND")
      },
    })
  })

  test("creates directories via the unified create endpoint", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await File.create({ parent: ".", name: "incoming", type: "directory" })

        expect(created.operation).toBe("create-directory")
        expect(created.destination).toBe("incoming")
        const stat = await fs.stat(path.join(tmp.path, "incoming"))
        expect(stat.isDirectory()).toBe(true)
      },
    })
  })

  test("rejects invalid basenames across path-separator and dot variants", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const name of ["", ".", "..", "a/b", "a\\b", "with\0null"]) {
          await expectOperationCode(
            File.create({ parent: ".", name, type: "file" }),
            "FILE_OP_INVALID_NAME",
          )
        }
      },
    })
  })

  test("renames files and rejects duplicate destinations", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "old.txt"), "body")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const renamed = await File.rename({ path: "docs/old.txt", name: "new.txt" })
        expect(renamed.operation).toBe("rename")
        expect(renamed.source).toBe("docs/old.txt")
        expect(renamed.destination).toBe("docs/new.txt")
        await expect(Bun.file(path.join(tmp.path, "docs", "new.txt")).text()).resolves.toBe("body")
        await expect(Bun.file(path.join(tmp.path, "docs", "old.txt")).exists()).resolves.toBe(false)

        // Pre-create a collision target then attempt to rename a different file onto it.
        await fs.writeFile(path.join(tmp.path, "docs", "other.txt"), "other")
        await expectOperationCode(
          File.rename({ path: "docs/other.txt", name: "new.txt" }),
          "FILE_OP_DUPLICATE",
        )
      },
    })
  })

  test("moves files between active-project directories and rejects duplicates", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.mkdir(path.join(dir, "incoming"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "a.txt"), "body")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const moved = await File.move({ source: "docs/a.txt", destinationParent: "incoming" })
        expect(moved.operation).toBe("move")
        expect(moved.source).toBe("docs/a.txt")
        expect(moved.destination).toBe("incoming/a.txt")
        expect(moved.affectedDirectories).toEqual(expect.arrayContaining(["docs", "incoming"]))
        await expect(Bun.file(path.join(tmp.path, "docs", "a.txt")).exists()).resolves.toBe(false)
        await expect(Bun.file(path.join(tmp.path, "incoming", "a.txt")).text()).resolves.toBe("body")

        // Re-add a colliding source then attempt to move into the populated destination.
        await fs.writeFile(path.join(tmp.path, "docs", "a.txt"), "again")
        await expectOperationCode(
          File.move({ source: "docs/a.txt", destinationParent: "incoming" }),
          "FILE_OP_DUPLICATE",
        )
      },
    })
  })

  test("copies files between active-project directories and rejects duplicates", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.mkdir(path.join(dir, "incoming"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "a.txt"), "body")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const copied = await File.copy({ source: "docs/a.txt", destinationParent: "incoming" })
        expect(copied.operation).toBe("copy")
        expect(copied.source).toBe("docs/a.txt")
        expect(copied.destination).toBe("incoming/a.txt")
        // Source preserved.
        await expect(Bun.file(path.join(tmp.path, "docs", "a.txt")).text()).resolves.toBe("body")
        await expect(Bun.file(path.join(tmp.path, "incoming", "a.txt")).text()).resolves.toBe("body")

        await expectOperationCode(
          File.copy({ source: "docs/a.txt", destinationParent: "incoming" }),
          "FILE_OP_DUPLICATE",
        )
      },
    })
  })

  test("deleteToRecyclebin requires confirmation", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "a.txt"), "body")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expectOperationCode(
          File.deleteToRecyclebin({ path: "docs/a.txt", confirmed: false }),
          "FILE_OP_CONFIRMATION_REQUIRED",
        )
        // File is still on disk after the rejected call.
        await expect(Bun.file(path.join(tmp.path, "docs", "a.txt")).text()).resolves.toBe("body")
      },
    })
  })

  test("rejects mutations on a symlink whose realpath escapes the project", async () => {
    await using outside = await tmpdir({
      init: async (dir) => {
        await fs.writeFile(path.join(dir, "secret.txt"), "secret")
      },
    })
    await using tmp = await tmpdir()

    // Build the symlink AFTER tmp is created so we know the project directory layout.
    await fs.symlink(path.join(outside.path, "secret.txt"), path.join(tmp.path, "leak"))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expectOperationCode(
          File.rename({ path: "leak", name: "captured.txt" }),
          "FILE_OP_PATH_ESCAPE",
        )
        await expectOperationCode(File.download({ path: "leak" }), "FILE_OP_PATH_ESCAPE")
        await expectOperationCode(
          File.deleteToRecyclebin({ path: "leak", confirmed: true }),
          "FILE_OP_PATH_ESCAPE",
        )
      },
    })
  })

  test("recyclebin tombstones stay unique across a rapid double-delete of the same basename", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "a.txt"), "first")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await File.deleteToRecyclebin({ path: "docs/a.txt", confirmed: true })
        await fs.writeFile(path.join(tmp.path, "docs", "a.txt"), "second")
        const second = await File.deleteToRecyclebin({ path: "docs/a.txt", confirmed: true })

        expect(first.destination).not.toBe(second.destination)
        await expect(Bun.file(path.join(tmp.path, first.destination!)).exists()).resolves.toBe(true)
        await expect(Bun.file(path.join(tmp.path, second.destination!)).exists()).resolves.toBe(true)
        // Metadata sidecars are also distinct (they piggy-back on the tombstone path).
        const meta1 = path.join(tmp.path, first.destination! + ".opencode-recycle.json")
        const meta2 = path.join(tmp.path, second.destination! + ".opencode-recycle.json")
        expect(meta1).not.toBe(meta2)
        await expect(Bun.file(meta1).exists()).resolves.toBe(true)
        await expect(Bun.file(meta2).exists()).resolves.toBe(true)
      },
    })
  })

  test("copy with scope:external writes into a writable directory outside the project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "a.txt"), "body")
      },
    })
    await using external = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.copy({
          source: "docs/a.txt",
          destinationParent: external.path,
          scope: "external",
        })
        expect(result.operation).toBe("copy")
        // Source remains intact in the active project.
        await expect(Bun.file(path.join(tmp.path, "docs", "a.txt")).text()).resolves.toBe("body")
        await expect(Bun.file(path.join(external.path, "a.txt")).text()).resolves.toBe("body")
      },
    })
  })

  test("move with scope:external relocates into an external directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "a.txt"), "body")
      },
    })
    await using external = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.move({
          source: "docs/a.txt",
          destinationParent: external.path,
          scope: "external",
        })
        expect(result.operation).toBe("move")
        await expect(Bun.file(path.join(tmp.path, "docs", "a.txt")).exists()).resolves.toBe(false)
        await expect(Bun.file(path.join(external.path, "a.txt")).text()).resolves.toBe("body")
      },
    })
  })

  test("scope:external still rejects when the destination cannot be written", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.writeFile(path.join(dir, "a.txt"), "body")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expectOperationCode(
          File.copy({ source: "a.txt", destinationParent: "/proc/1", scope: "external" }),
          "FILE_OP_PERMISSION_DENIED",
        )
      },
    })
  })

  test("scope:external rejects a missing destination directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.writeFile(path.join(dir, "a.txt"), "body")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expectOperationCode(
          File.copy({
            source: "a.txt",
            destinationParent: "/tmp/opencode-doesnotexist-" + Math.random().toString(36).slice(2),
            scope: "external",
          }),
          "FILE_OP_DESTINATION_AMBIGUOUS",
        )
      },
    })
  })

  test("destinationPreflight reports external writable directory as writable", async () => {
    await using tmp = await tmpdir()
    await using external = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.destinationPreflight({
          destinationParent: external.path,
          scope: "external",
        })

        expect(result.writable).toBe(true)
        expect(result.reason).toBeUndefined()
        expect(path.resolve(result.canonicalPath)).toBe(path.resolve(external.path))
      },
    })
  })

  test("emits operation requested + completed events on success", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const captured = captureFileEvents()
        try {
          await File.create({ parent: ".", name: "evt.txt", type: "file" })
          await flushPendingPublishes()

          const types = captured.events.map((e) => e.type)
          expect(types).toEqual(["file.operation.requested", "file.operation.completed"])

          const requested = captured.events[0]
          expect(requested.properties).toMatchObject({
            operation: "create-file",
            input: { parent: ".", name: "evt.txt", type: "file" },
          })

          const completed = captured.events[1]
          expect(completed.properties).toMatchObject({
            operation: "create-file",
            destination: "evt.txt",
          })
          expect(typeof completed.properties.durationMs).toBe("number")
        } finally {
          captured.stop()
        }
      },
    })
  })

  test("emits operation rejected event with code on failure", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const captured = captureFileEvents()
        try {
          await expectOperationCode(
            File.create({ parent: ".", name: "../escape.txt", type: "file" }),
            "FILE_OP_INVALID_NAME",
          )
          await flushPendingPublishes()

          const types = captured.events.map((e) => e.type)
          expect(types).toEqual(["file.operation.requested", "file.operation.rejected"])

          const rejected = captured.events[1]
          expect(rejected.properties).toMatchObject({
            operation: "create-file",
            code: "FILE_OP_INVALID_NAME",
          })
        } finally {
          captured.stop()
        }
      },
    })
  })

  test("list returns size and modifiedAt for files; modifiedAt for directories", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await fs.writeFile(path.join(dir, "docs", "a.txt"), "hello")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const docs = await File.list("docs")
        const file = docs.find((n) => n.name === "a.txt")
        expect(file).toBeDefined()
        expect(file!.size).toBe(5)
        expect(typeof file!.modifiedAt).toBe("number")
        expect(file!.modifiedAt!).toBeGreaterThan(0)

        const root = await File.list("")
        const folder = root.find((n) => n.name === "docs")
        expect(folder).toBeDefined()
        // Directories must not carry an aggregate size in V1.
        expect(folder!.size).toBeUndefined()
        expect(typeof folder!.modifiedAt).toBe("number")
      },
    })
  })

  test("upload telemetry redacts Blob bytes to size + type metadata", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const captured = captureFileEvents()
        try {
          await File.upload({
            parent: "docs",
            filename: "tele.txt",
            source: new Blob(["secret-bytes"], { type: "text/plain" }),
          })
          await flushPendingPublishes()

          const requested = captured.events.find((e) => e.type === "file.operation.requested")
          expect(requested).toBeDefined()
          const input = requested!.properties.input as Record<string, unknown>
          // The Blob is replaced with a metadata stub; original bytes are not in the payload.
          expect(input.source).toMatchObject({ kind: "blob", size: 12 })
          expect(typeof input.source).toBe("object")
          expect(JSON.stringify(input)).not.toContain("secret-bytes")
        } finally {
          captured.stop()
        }
      },
    })
  })
})
