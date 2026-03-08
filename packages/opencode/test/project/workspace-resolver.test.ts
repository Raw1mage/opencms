import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { Project } from "../../src/project/project"
import {
  createInMemoryWorkspaceRegistry,
  createWorkspaceId,
  normalizeWorkspaceDirectory,
  resolveWorkspaceFromProject,
  resolveWorkspaceWithRegistry,
} from "../../src/project/workspace"

describe("project.workspace.resolver", () => {
  test("resolves root workspace from project root", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)

    const workspace = resolveWorkspaceFromProject({ project, directory: tmp.path })

    expect(workspace.kind).toBe("root")
    expect(workspace.directory).toBe(normalizeWorkspaceDirectory(tmp.path))
    expect(workspace.projectId).toBe(project.id)
    expect(workspace.workspaceId).toBe(
      createWorkspaceId({
        directory: normalizeWorkspaceDirectory(tmp.path),
        projectId: project.id,
        kind: "root",
      }),
    )
  })

  test("resolves sandbox workspace from git worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktreePath = path.join(tmp.path, "..", "workspace-kernel-sandbox")
    await $`git worktree add ${worktreePath} -b workspace-kernel-sandbox`.cwd(tmp.path).quiet()

    try {
      const { project } = await Project.fromDirectory(worktreePath)
      const workspace = resolveWorkspaceFromProject({ project, directory: worktreePath })

      expect(workspace.kind).toBe("sandbox")
      expect(workspace.directory).toBe(normalizeWorkspaceDirectory(worktreePath))
      expect(workspace.projectId).toBe(project.id)
    } finally {
      await $`git worktree remove ${worktreePath}`.cwd(tmp.path).quiet()
    }
  })

  test("resolveWorkspaceWithRegistry caches normalized workspace lookups", async () => {
    await using tmp = await tmpdir({ git: true })
    const registry = createInMemoryWorkspaceRegistry()

    const first = await resolveWorkspaceWithRegistry({
      directory: `${tmp.path}///`,
      registry,
    })
    const second = await resolveWorkspaceWithRegistry({
      directory: tmp.path,
      registry,
    })

    expect(second.workspaceId).toBe(first.workspaceId)
    expect(second.directory).toBe(normalizeWorkspaceDirectory(tmp.path))
    expect(await registry.getByDirectory(tmp.path)).toEqual(second)
    expect((await registry.listByProject(first.projectId)).map((item) => item.workspaceId)).toEqual([first.workspaceId])
  })
})
