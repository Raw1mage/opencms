import z from "zod"
import { Instance } from "../instance"
import { Project } from "../project"
import { Session } from "@/session"
import { Worktree } from "@/worktree"
import { WorkspaceService, type WorkspaceService as WorkspaceServiceType } from "./service"

export const WorkspaceResetOperationResultSchema = z.object({
  workspace: z.object({
    workspaceId: z.string(),
    projectId: z.string(),
    directory: z.string(),
    kind: z.enum(["root", "sandbox", "derived"]),
    origin: z.enum(["local", "generated", "imported"]),
    lifecycleState: z.enum(["active", "archived", "resetting", "deleting", "failed"]),
    displayName: z.string().optional(),
    branch: z.string().optional(),
    attachments: z.object({
      sessionIds: z.array(z.string()),
      activeSessionId: z.string().optional(),
      ptyIds: z.array(z.string()),
      previewIds: z.array(z.string()),
      workerIds: z.array(z.string()),
      draftKeys: z.array(z.string()),
      fileTabKeys: z.array(z.string()),
      commentKeys: z.array(z.string()),
    }),
  }),
  archivedSessionIDs: z.array(z.string()),
  archivedSessionCount: z.number(),
})
export type WorkspaceResetOperationResult = z.infer<typeof WorkspaceResetOperationResultSchema>

type WorkspaceOperationDeps = {
  service: WorkspaceServiceType
  listSessions: (
    directory: string,
  ) => Promise<Array<Pick<Session.Info, "id" | "directory"> & { time: { archived?: number } }>>
  archiveSession: (sessionID: string, archivedAt: number) => Promise<void>
  disposeDirectory: (directory: string) => Promise<void>
  resetWorktree: (directory: string) => Promise<void>
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
  }
}

export const WorkspaceOperation = createWorkspaceOperations()
