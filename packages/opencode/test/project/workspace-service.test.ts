import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import {
  createWorkspaceService,
  buildDerivedWorkspace,
  createInMemoryWorkspaceRegistry,
  normalizeWorkspaceDirectory,
  resolveWorkspaceViaService,
} from "../../src/project/workspace"

describe("project.workspace.service", () => {
  test("resolves and caches workspaces through service registry", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = createWorkspaceService(createInMemoryWorkspaceRegistry())

    const first = await service.resolve({ directory: `${tmp.path}///` })
    const second = await service.getByDirectory(tmp.path)

    expect(second?.workspaceId).toBe(first.workspaceId)
    expect(second?.directory).toBe(normalizeWorkspaceDirectory(tmp.path))
  })

  test("register exposes manual upsert and project listing", async () => {
    const service = createWorkspaceService(createInMemoryWorkspaceRegistry())
    const workspace = buildDerivedWorkspace({
      projectId: "project-1",
      directory: "/tmp/workspace-derived",
    })

    await service.register(workspace)

    expect(await service.getById(workspace.workspaceId)).toEqual(workspace)
    expect((await service.listByProject("project-1")).map((item) => item.workspaceId)).toEqual([workspace.workspaceId])
  })

  test("resolveWorkspaceViaService uses provided service", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = createWorkspaceService(createInMemoryWorkspaceRegistry())

    const workspace = await resolveWorkspaceViaService({
      directory: tmp.path,
      service,
    })

    expect(await service.getById(workspace.workspaceId)).toEqual(workspace)
  })

  test("attachSession and detachSession update workspace attachments", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = createWorkspaceService(createInMemoryWorkspaceRegistry())

    await service.attachSession({ id: "session-1", directory: tmp.path, active: true })
    const attached = await service.getByDirectory(tmp.path)
    expect(attached?.attachments.sessionIds).toEqual(["session-1"])
    expect(attached?.attachments.activeSessionId).toBe("session-1")

    await service.detachSession({ sessionID: "session-1", directory: tmp.path })
    const detached = await service.getByDirectory(tmp.path)
    expect(detached?.attachments.sessionIds).toEqual([])
    expect(detached?.attachments.activeSessionId).toBeUndefined()
  })

  test("attachPty and detachPty update workspace attachments", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = createWorkspaceService(createInMemoryWorkspaceRegistry())

    await service.attachPty({ id: "pty-1", cwd: `${tmp.path}///` })
    const attached = await service.getByDirectory(tmp.path)
    expect(attached?.attachments.ptyIds).toEqual(["pty-1"])

    await service.detachPty({ ptyID: "pty-1" })
    const detached = await service.getByDirectory(tmp.path)
    expect(detached?.attachments.ptyIds).toEqual([])
  })

  test("listProjectWorkspaces resolves root and sandbox entries for project shape", async () => {
    await using tmp = await tmpdir({ git: true })
    const sandboxDirectory = `${tmp.path}/sandbox-a`
    const service = createWorkspaceService(createInMemoryWorkspaceRegistry())

    const workspaces = await service.listProjectWorkspaces({
      id: "project-1",
      worktree: tmp.path,
      sandboxes: [sandboxDirectory],
    })

    expect(workspaces.map((item) => item.directory)).toEqual([normalizeWorkspaceDirectory(tmp.path), sandboxDirectory])
    expect(workspaces.map((item) => item.kind)).toEqual(["root", "sandbox"])
  })

  test("getProjectStatus summarizes workspace and attachment counts", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = createWorkspaceService(createInMemoryWorkspaceRegistry())
    const resolved = await service.resolve({ directory: tmp.path })

    await service.attachSession({ id: "session-1", directory: tmp.path, active: true })
    await service.attachPty({ id: "pty-1", cwd: tmp.path })

    const status = await service.getProjectStatus({
      id: resolved.projectId,
      worktree: tmp.path,
      sandboxes: [],
    })

    expect(status).toEqual({
      projectId: resolved.projectId,
      total: 1,
      kinds: { root: 1, sandbox: 0, derived: 0 },
      attachments: { sessions: 1, ptys: 1, previews: 0, workers: 0 },
    })
  })
})
