import { describe, expect, test } from "bun:test"
import { createWorkspaceId, deriveWorkspaceKind, normalizeWorkspaceDirectory } from "./workspace-adapter"

describe("global-sync workspace adapter", () => {
  test("normalizes directories and derives root workspace kind", () => {
    expect(normalizeWorkspaceDirectory("/repo///")).toBe("/repo")
    expect(deriveWorkspaceKind({ directory: "/repo///", worktree: "/repo" })).toBe("root")
  })

  test("derives sandbox workspace kind and stable workspace id", () => {
    const directory = "/repo/sandbox-a/"
    const normalized = normalizeWorkspaceDirectory(directory)
    expect(deriveWorkspaceKind({ directory, worktree: "/repo" })).toBe("sandbox")
    expect(
      createWorkspaceId({
        directory,
        projectId: "project-1",
        kind: "sandbox",
      }),
    ).toBe(
      createWorkspaceId({
        directory: normalized,
        projectId: "project-1",
        kind: "sandbox",
      }),
    )
  })

  test("normalizes mixed separators and dot segments without node:path", () => {
    expect(normalizeWorkspaceDirectory("C:\\repo\\workspace\\..\\sandbox\\")).toBe("C:/repo/sandbox")
    expect(normalizeWorkspaceDirectory("/repo//nested/./sandbox/../child/")).toBe("/repo/nested/child")
  })
})
