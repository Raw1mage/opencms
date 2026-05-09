import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

async function expectOperationCode(input: Promise<unknown>, code: File.OperationCode) {
  await expect(input).rejects.toMatchObject({ code })
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
})
