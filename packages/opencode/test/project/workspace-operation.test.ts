import { describe, expect, test } from "bun:test"
import {
  buildSandboxWorkspace,
  createInMemoryWorkspaceRegistry,
  createWorkspaceOperations,
  createWorkspaceService,
} from "../../src/project/workspace"

describe("project.workspace.operation", () => {
  test("reset archives active sessions, disposes instance, resets worktree, and marks workspace active", async () => {
    const service = createWorkspaceService(createInMemoryWorkspaceRegistry())
    const workspace = await service.register(
      buildSandboxWorkspace({
        projectId: "project-1",
        directory: "/tmp/workspace-op-reset",
      }),
    )
    const archived: Array<{ id: string; archivedAt: number }> = []
    const disposed: string[] = []
    const reset: string[] = []

    const operation = createWorkspaceOperations({
      service,
      listSessions: async () => [
        { id: "ses-1", directory: workspace.directory, time: {} },
        { id: "ses-2", directory: workspace.directory, time: { archived: 1 } },
      ],
      archiveSession: async (sessionID, archivedAt) => {
        archived.push({ id: sessionID, archivedAt })
      },
      disposeDirectory: async (directory) => {
        disposed.push(directory)
      },
      resetWorktree: async (directory) => {
        reset.push(directory)
      },
    })

    const result = await operation.reset({ workspaceID: workspace.workspaceId })

    expect(result.archivedSessionIDs).toEqual(["ses-1"])
    expect(result.archivedSessionCount).toBe(1)
    expect(archived.map((item) => item.id)).toEqual(["ses-1"])
    expect(disposed).toEqual([workspace.directory])
    expect(reset).toEqual([workspace.directory])
    expect(result.workspace.lifecycleState).toBe("active")
  })

  test("reset marks workspace failed when runtime reset fails", async () => {
    const service = createWorkspaceService(createInMemoryWorkspaceRegistry())
    const workspace = await service.register(
      buildSandboxWorkspace({
        projectId: "project-1",
        directory: "/tmp/workspace-op-fail",
      }),
    )

    const operation = createWorkspaceOperations({
      service,
      listSessions: async () => [],
      archiveSession: async () => undefined,
      disposeDirectory: async () => undefined,
      resetWorktree: async () => {
        throw new Error("boom")
      },
    })

    await expect(operation.reset({ workspaceID: workspace.workspaceId })).rejects.toThrow("boom")
    expect((await service.getById(workspace.workspaceId))?.lifecycleState).toBe("failed")
  })
})
