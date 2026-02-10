import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { installBundledSkills, isDirectory } from "../../src/global/bundled-skills"

const tmpRoots: string[] = []

async function mkTempRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => {
      return fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }),
  )
})

describe("bundled skills guards", () => {
  test("isDirectory returns false for ENOENT and throws non-ENOENT", async () => {
    const missingPath = path.join(await mkTempRoot("opencode-bundled-"), "does-not-exist")
    await expect(isDirectory(missingPath)).resolves.toBe(false)

    // NUL byte path should raise a non-ENOENT error and must not be swallowed.
    await expect(isDirectory("\0invalid")).rejects.toThrow()
  })

  test("installBundledSkills only writes version marker after successful copy", async () => {
    const root = await mkTempRoot("opencode-bundled-atomic-")
    const templatesRoot = path.join(root, "templates")
    const dataRoot = path.join(root, "data")
    const srcRoot = path.join(templatesRoot, "skills")
    const dstRoot = path.join(dataRoot, "skills")

    await fs.mkdir(srcRoot, { recursive: true })
    await fs.mkdir(dataRoot, { recursive: true })

    await expect(
      installBundledSkills({
        srcRoot,
        dstRoot,
        templatesRoot,
        dataRoot,
        version: "1",
        copyTree: async () => {
          throw new Error("copy failed")
        },
      }),
    ).rejects.toThrow("copy failed")

    const marker = path.join(dstRoot, ".bundled-version")
    await expect(Bun.file(marker).exists()).resolves.toBe(false)
  })

  test("installBundledSkills rejects symlink source escaping template root", async () => {
    const root = await mkTempRoot("opencode-bundled-symlink-")
    const templatesRoot = path.join(root, "templates")
    const dataRoot = path.join(root, "data")
    const outsideRoot = path.join(root, "outside")
    const symlinkPath = path.join(templatesRoot, "skills-link")
    const dstRoot = path.join(dataRoot, "skills")

    await fs.mkdir(path.join(outsideRoot, "nested"), { recursive: true })
    await fs.mkdir(templatesRoot, { recursive: true })
    await fs.mkdir(dataRoot, { recursive: true })
    await Bun.write(path.join(outsideRoot, "nested", "skill.txt"), "demo")
    await fs.symlink(outsideRoot, symlinkPath)

    await expect(
      installBundledSkills({
        srcRoot: symlinkPath,
        dstRoot,
        templatesRoot,
        dataRoot,
        version: "1",
      }),
    ).rejects.toThrow("outside allowed root")
  })
})
