import z from "zod"
import { Instance } from "../instance"
import { Project } from "../project"
import { Session } from "@/session"
import { Worktree } from "@/worktree"
import { WorkspaceService, type WorkspaceService as WorkspaceServiceType } from "./service"
import { WorkspaceAggregateSchema } from "./types"

export const WorkspaceResetOperationResultSchema = z.object({
  workspace: WorkspaceAggregateSchema,
  archivedSessionIDs: z.array(z.string()),
  archivedSessionCount: z.number(),
})
export type WorkspaceResetOperationResult = z.infer<typeof WorkspaceResetOperationResultSchema>

export const WorkspaceDeleteOperationResultSchema = z.object({
  workspace: WorkspaceAggregateSchema,
  archivedSessionIDs: z.array(z.string()),
  archivedSessionCount: z.number(),
  removedDirectory: z.string(),
  removedFromProjectId: z.string(),
})
export type WorkspaceDeleteOperationResult = z.infer<typeof WorkspaceDeleteOperationResultSchema>

type WorkspaceOperationDeps = {
  service: WorkspaceServiceType
  listSessions: (
    directory: string,
  ) => Promise<Array<Pick<Session.Info, "id" | "directory"> & { time: { archived?: number } }>>
  archiveSession: (sessionID: string, archivedAt: number) => Promise<void>
  disposeDirectory: (directory: string) => Promise<void>
  resetWorktree: (directory: string) => Promise<void>
  removeWorktree: (directory: string) => Promise<void>
  removeSandbox: (projectID: string, directory: string) => Promise<void>
}

export function createWorkspaceOperations(deps?: Partial<WorkspaceOperationDeps>) {
  const service = deps?.service ?? WorkspaceService
  const listSessions =
    deps?.listSessions ??
    (async (directory: string) => {
      const result: Array<Pick<Session.Info, "id" | "directory"> & { time: { archived?: number } }> = []
      for await (const session of Session.listGlobal({ directory, archived: true, limit: 1000 })) {
        result.push(session)
      }
      return result
    })
  const archiveSession =
    deps?.archiveSession ??
    (async (sessionID: string, archivedAt: number) => {
      await Session.update(
        sessionID,
        (draft) => {
          draft.time.archived = archivedAt
        },
        { touch: false },
      )
    })
  const disposeDirectory =
    deps?.disposeDirectory ??
    (async (directory: string) => {
      await Instance.provide({
        directory,
        fn: () => Instance.dispose(),
      })
    })
  const resetWorktree =
    deps?.resetWorktree ??
    (async (directory: string) => {
      const located = await Project.fromDirectory(directory)
      await Instance.provide({
        directory: located.project.worktree,
        fn: () => Worktree.reset({ directory }),
      })
    })
  const removeWorktree =
    deps?.removeWorktree ??
    (async (directory: string) => {
      const located = await Project.fromDirectory(directory)
      await Instance.provide({
        directory: located.project.worktree,
        fn: () => Worktree.remove({ directory }),
      })
    })
  const removeSandbox = deps?.removeSandbox ?? Project.removeSandbox

  return {
    async reset(input: { workspaceID: string }): Promise<WorkspaceResetOperationResult> {
      const workspace = await service.getById(input.workspaceID)
      if (!workspace) throw new Error(`Workspace not found: ${input.workspaceID}`)
      if (workspace.kind === "root") throw new Error("Cannot reset the primary workspace")

      await service.markResetting({ workspaceID: workspace.workspaceId })

      try {
        const sessions = await listSessions(workspace.directory)
        const archivedAt = Date.now()
        const activeSessions = sessions.filter((session) => session.time.archived === undefined)
        await Promise.all(activeSessions.map((session) => archiveSession(session.id, archivedAt)))
        await disposeDirectory(workspace.directory).catch(() => undefined)
        await resetWorktree(workspace.directory)
        const updated = await service.markActive({ workspaceID: workspace.workspaceId })
        return {
          workspace: updated,
          archivedSessionIDs: activeSessions.map((session) => session.id),
          archivedSessionCount: activeSessions.length,
        }
      } catch (error) {
        await service.markFailed({ workspaceID: workspace.workspaceId }).catch(() => undefined)
        throw error
      }
    },
    async delete(input: { workspaceID: string }): Promise<WorkspaceDeleteOperationResult> {
      const workspace = await service.getById(input.workspaceID)
      if (!workspace) throw new Error(`Workspace not found: ${input.workspaceID}`)
      if (workspace.kind === "root") throw new Error("Cannot delete the primary workspace")

      await service.markDeleting({ workspaceID: workspace.workspaceId })

      try {
        const sessions = await listSessions(workspace.directory)
        const archivedAt = Date.now()
        const activeSessions = sessions.filter((session) => session.time.archived === undefined)
        await Promise.all(activeSessions.map((session) => archiveSession(session.id, archivedAt)))
        await disposeDirectory(workspace.directory).catch(() => undefined)
        await removeWorktree(workspace.directory)
        await removeSandbox(workspace.projectId, workspace.directory)
        const updated = await service.markArchived({ workspaceID: workspace.workspaceId })
        return {
          workspace: updated,
          archivedSessionIDs: activeSessions.map((session) => session.id),
          archivedSessionCount: activeSessions.length,
          removedDirectory: workspace.directory,
          removedFromProjectId: workspace.projectId,
        }
      } catch (error) {
        await service.markFailed({ workspaceID: workspace.workspaceId }).catch(() => undefined)
        throw error
      }
    },
  }
}

export const WorkspaceOperation = createWorkspaceOperations()
