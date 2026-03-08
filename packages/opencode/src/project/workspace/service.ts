import { Bus } from "@/bus"
import { Pty } from "@/pty"
import { Session } from "@/session"
import type { Project } from "../project"
import { summarizeWorkspaceAttachments, type WorkspaceAttachmentDescriptor } from "./attachments"
import { buildRootWorkspace, buildSandboxWorkspace } from "./resolver"
import type { WorkspaceAggregate } from "./types"
import { createInMemoryWorkspaceRegistry, type WorkspaceRegistry } from "./registry"
import { normalizeWorkspaceDirectory } from "./identity"
import { resolveWorkspace, resolveWorkspaceWithRegistry } from "./resolver"

export interface WorkspaceService {
  registry: WorkspaceRegistry
  resolve(input: { directory: string }): Promise<WorkspaceAggregate>
  register(workspace: WorkspaceAggregate): Promise<WorkspaceAggregate>
  getByDirectory(directory: string): Promise<WorkspaceAggregate | undefined>
  getById(workspaceId: string): Promise<WorkspaceAggregate | undefined>
  listByProject(projectId: string): Promise<WorkspaceAggregate[]>
  listProjectWorkspaces(project: Pick<Project.Info, "id" | "worktree" | "sandboxes">): Promise<WorkspaceAggregate[]>
  getProjectStatus(project: Pick<Project.Info, "id" | "worktree" | "sandboxes">): Promise<{
    projectId: string
    total: number
    kinds: { root: number; sandbox: number; derived: number }
    attachments: { sessions: number; ptys: number; previews: number; workers: number }
  }>
  attachSession(info: Pick<Session.Info, "id" | "directory"> & { active?: boolean }): Promise<WorkspaceAggregate>
  detachSession(input: { sessionID: string; directory: string }): Promise<WorkspaceAggregate>
  attachPty(info: Pick<Pty.Info, "id" | "cwd">): Promise<WorkspaceAggregate>
  detachPty(input: { ptyID: string; directory?: string }): Promise<WorkspaceAggregate | undefined>
  initEventSubscriptions(): void
}

export function createWorkspaceService(
  registry: WorkspaceRegistry = createInMemoryWorkspaceRegistry(),
): WorkspaceService {
  const ptyDirectoryById = new Map<string, string>()
  let subscriptionsInitialized = false

  async function updateAttachments(
    directory: string,
    updater: (descriptors: WorkspaceAttachmentDescriptor[]) => WorkspaceAttachmentDescriptor[],
  ) {
    const workspace = await resolveWorkspaceWithRegistry({ directory, registry })
    const descriptors: WorkspaceAttachmentDescriptor[] = [
      ...workspace.attachments.sessionIds.map((key) => ({
        type: "session" as const,
        ownership: "session" as const,
        key,
        active: workspace.attachments.activeSessionId === key,
      })),
      ...workspace.attachments.ptyIds.map((key) => ({
        type: "pty" as const,
        ownership: "workspace" as const,
        key,
      })),
      ...workspace.attachments.previewIds.map((key) => ({
        type: "preview" as const,
        ownership: "workspace" as const,
        key,
      })),
      ...workspace.attachments.workerIds.map((key) => ({
        type: "worker" as const,
        ownership: "workspace" as const,
        key,
      })),
      ...workspace.attachments.draftKeys.map((key) => ({
        type: "draft" as const,
        ownership: "session_with_workspace_default" as const,
        key,
      })),
      ...workspace.attachments.fileTabKeys.map((key) => ({
        type: "file_tab" as const,
        ownership: "session_with_workspace_default" as const,
        key,
      })),
      ...workspace.attachments.commentKeys.map((key) => ({
        type: "comment" as const,
        ownership: "session_with_workspace_default" as const,
        key,
      })),
    ]

    return registry.upsert({
      ...workspace,
      attachments: summarizeWorkspaceAttachments(updater(descriptors)),
    })
  }

  return {
    registry,
    resolve(input) {
      return resolveWorkspaceWithRegistry({
        directory: input.directory,
        registry,
      })
    },
    register(workspace) {
      return registry.upsert(workspace)
    },
    getByDirectory(directory) {
      return registry.getByDirectory(normalizeWorkspaceDirectory(directory))
    },
    getById(workspaceId) {
      return registry.getById(workspaceId)
    },
    listByProject(projectId) {
      return registry.listByProject(projectId)
    },
    async listProjectWorkspaces(project) {
      const rootDirectory = normalizeWorkspaceDirectory(project.worktree)
      const rootExisting = await registry.getByDirectory(rootDirectory)
      if (!rootExisting || rootExisting.projectId !== project.id || rootExisting.kind !== "root") {
        await registry.upsert(
          buildRootWorkspace({
            projectId: project.id,
            directory: rootDirectory,
          }),
        )
      }

      for (const directory of project.sandboxes ?? []) {
        const normalized = normalizeWorkspaceDirectory(directory)
        const existing = await registry.getByDirectory(normalized)
        if (existing && existing.projectId === project.id && existing.kind === "sandbox") continue
        await registry.upsert(
          buildSandboxWorkspace({
            projectId: project.id,
            directory: normalized,
          }),
        )
      }
      return registry.listByProject(project.id)
    },
    async getProjectStatus(project) {
      const workspaces = await this.listProjectWorkspaces(project)
      return {
        projectId: project.id,
        total: workspaces.length,
        kinds: {
          root: workspaces.filter((item) => item.kind === "root").length,
          sandbox: workspaces.filter((item) => item.kind === "sandbox").length,
          derived: workspaces.filter((item) => item.kind === "derived").length,
        },
        attachments: {
          sessions: workspaces.reduce((sum, item) => sum + item.attachments.sessionIds.length, 0),
          ptys: workspaces.reduce((sum, item) => sum + item.attachments.ptyIds.length, 0),
          previews: workspaces.reduce((sum, item) => sum + item.attachments.previewIds.length, 0),
          workers: workspaces.reduce((sum, item) => sum + item.attachments.workerIds.length, 0),
        },
      }
    },
    attachSession(info) {
      return updateAttachments(info.directory, (descriptors) => {
        const next = descriptors.filter((item) => !(item.type === "session" && item.key === info.id))
        next.push({
          type: "session",
          ownership: "session",
          key: info.id,
          active: info.active,
        })
        if (info.active) {
          for (const item of next) {
            if (item.type === "session" && item.key !== info.id) item.active = false
          }
        }
        return next
      })
    },
    detachSession(input) {
      return updateAttachments(input.directory, (descriptors) =>
        descriptors.filter((item) => !(item.type === "session" && item.key === input.sessionID)),
      )
    },
    attachPty(info) {
      ptyDirectoryById.set(info.id, normalizeWorkspaceDirectory(info.cwd))
      return updateAttachments(info.cwd, (descriptors) => {
        const next = descriptors.filter((item) => !(item.type === "pty" && item.key === info.id))
        next.push({
          type: "pty",
          ownership: "workspace",
          key: info.id,
        })
        return next
      })
    },
    async detachPty(input) {
      const directory = input.directory ?? ptyDirectoryById.get(input.ptyID)
      if (!directory) return undefined
      ptyDirectoryById.delete(input.ptyID)
      return updateAttachments(directory, (descriptors) =>
        descriptors.filter((item) => !(item.type === "pty" && item.key === input.ptyID)),
      )
    },
    initEventSubscriptions() {
      if (subscriptionsInitialized) return
      subscriptionsInitialized = true
      Bus.subscribe(Session.Event.Created, (evt) => {
        void this.attachSession({ id: evt.properties.info.id, directory: evt.properties.info.directory, active: true })
      })
      Bus.subscribe(Session.Event.Deleted, (evt) => {
        void this.detachSession({ sessionID: evt.properties.info.id, directory: evt.properties.info.directory })
      })
      Bus.subscribe(Pty.Event.Created, (evt) => {
        void this.attachPty({ id: evt.properties.info.id, cwd: evt.properties.info.cwd })
      })
      Bus.subscribe(Pty.Event.Deleted, (evt) => {
        void this.detachPty({ ptyID: evt.properties.id })
      })
      Bus.subscribe(Pty.Event.Exited, (evt) => {
        void this.detachPty({ ptyID: evt.properties.id })
      })
    },
  }
}

export const WorkspaceService = createWorkspaceService()

export async function resolveWorkspaceViaService(input: { directory: string; service?: WorkspaceService }) {
  const service = input.service ?? WorkspaceService
  return service.resolve({ directory: input.directory })
}

export async function resolveWorkspaceDirect(input: { directory: string }) {
  return resolveWorkspace(input)
}
