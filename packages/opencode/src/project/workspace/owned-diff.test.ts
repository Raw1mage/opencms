import { afterEach, describe, expect, it } from "bun:test"
import { $ } from "bun"
import path from "path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { File } from "../../file"
import { Instance } from "../../project/instance"
import { collectOwnedSessionCandidateFiles } from "./owned-diff"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("owned session dirty diff", () => {
  it("collects only session-owned candidate files shared by touched tools and latest summary diffs", () => {
    const directory = "/repo"
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "write",
            state: {
              status: "completed",
              input: { filePath: "/repo/packages/a.ts" },
            },
          },
          {
            type: "tool",
            tool: "apply_patch",
            state: {
              status: "completed",
              input: {
                patchText: "*** Begin Patch\n*** Update File: docs/guide.md\n@@\n-old\n+new\n*** End Patch",
              },
            },
          },
        ],
      },
      {
        info: {
          role: "user",
          summary: {
            diffs: [
              { file: "packages/a.ts", before: "old", after: "new", additions: 1, deletions: 1, status: "modified" },
              { file: "docs/guide.md", before: "old", after: "new", additions: 1, deletions: 1, status: "modified" },
              { file: "extra/unowned.ts", before: "old", after: "new", additions: 1, deletions: 1, status: "modified" },
            ],
          },
        },
        parts: [],
      },
    ] as any

    expect(collectOwnedSessionCandidateFiles(messages, directory)).toEqual(["docs/guide.md", "packages/a.ts"])
  })

  it("limits file status to requested session-owned paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-owned-diff-"))
    try {
      await $`git init`.cwd(directory).quiet()
      await writeFile(path.join(directory, "a.txt"), "a\n")
      await writeFile(path.join(directory, "b.txt"), "b\n")
      await $`git add a.txt b.txt`.cwd(directory).quiet()
      await $`git -c user.name=Test -c user.email=test@example.com commit -m init`.cwd(directory).quiet()

      await writeFile(path.join(directory, "a.txt"), "a changed\n")
      await writeFile(path.join(directory, "b.txt"), "b changed\n")
      await writeFile(path.join(directory, "c.txt"), "c new\n")

      const diffs = await Instance.provide({
        directory,
        fn: () => File.status({ paths: ["a.txt", "c.txt"] }),
      })

      expect(diffs.map((item) => item.path).sort()).toEqual(["a.txt", "c.txt"])
      expect(diffs.find((item) => item.path === "a.txt")?.status).toBe("modified")
      expect(diffs.find((item) => item.path === "c.txt")?.status).toBe("added")
      expect(diffs.some((item) => item.path === "b.txt")).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
