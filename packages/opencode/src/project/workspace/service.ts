import { Bus } from "@/bus"
import { Pty } from "@/pty"
import { Session } from "@/session"
import { TaskWorkerEvent } from "@/tool/task"
import type { Project } from "../project"
import { summarizeWorkspaceAttachments, type WorkspaceAttachmentDescriptor } from "./attachments"
import { WorkspaceEvent } from "./events"
import { buildRootWorkspace, buildSandboxWorkspace } from "./resolver"
import {
  markWorkspaceActive,
  markWorkspaceArchived,
  markWorkspaceDeleting,
  markWorkspaceFailed,
  markWorkspaceResetting,
} from "./lifecycle"
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
  markResetting(input: { workspaceID: string }): Promise<WorkspaceAggregate>
  markDeleting(input: { workspaceID: string }): Promise<WorkspaceAggregate>
  markArchived(input: { workspaceID: string }): Promise<WorkspaceAggregate>
  markActive(input: { workspaceID: string }): Promise<WorkspaceAggregate>
  markFailed(input: { workspaceID: string }): Promise<WorkspaceAggregate>
  attachSession(info: Pick<Session.Info, "id" | "directory"> & { active?: boolean }): Promise<WorkspaceAggregate>
  detachSession(input: { sessionID: string; directory: string }): Promise<WorkspaceAggregate>
  attachPty(info: Pick<Pty.Info, "id" | "cwd">): Promise<WorkspaceAggregate>
  detachPty(input: { ptyID: string; directory?: string }): Promise<WorkspaceAggregate | undefined>
  attachWorker(input: { workerID: string; sessionID: string }): Promise<WorkspaceAggregate>
  detachWorker(input: { workerID: string; directory?: string }): Promise<WorkspaceAggregate | undefined>
  initEventSubscriptions(): void
}

export function createWorkspaceService(
  registry: WorkspaceRegistry = createInMemoryWorkspaceRegistry(),
): WorkspaceService {
  const ptyDirectoryById = new Map<string, string>()
  const workerDirectoryById = new Map<string, string>()
  let subscriptionsInitialized = false

  async function upsertAndPublish(next: WorkspaceAggregate) {
    const previous = await registry.getById(next.workspaceId)
    const workspace = await registry.upsert(next)
    if (!previous) {
      await Bus.publish(WorkspaceEvent.Created, { workspace })
    }
    await Bus.publish(WorkspaceEvent.Updated, { workspace, previous })
    return workspace
  }

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

    const nextDescriptors = updater(descriptors)
    const nextWorkspace = {
      ...workspace,
      attachments: summarizeWorkspaceAttachments(nextDescriptors),
    }
    const updated = await upsertAndPublish(nextWorkspace)

    const keyOf = (item: WorkspaceAttachmentDescriptor) => `${item.type}:${item.key}`
    const previousMap = new Map(descriptors.map((item) => [keyOf(item), item]))
    const nextMap = new Map(nextDescriptors.map((item) => [keyOf(item), item]))

    for (const [key, item] of nextMap) {
      if (!previousMap.has(key)) {
        await Bus.publish(WorkspaceEvent.AttachmentAdded, {
          workspace: updated,
          attachment: item,
        })
      }
    }

    for (const [key, item] of previousMap) {
      if (!nextMap.has(key)) {
        await Bus.publish(WorkspaceEvent.AttachmentRemoved, {
          workspace: updated,
          attachment: item,
        })
      }
    }

    return updated
  }

  async function updateLifecycle(workspaceID: string, updater: (workspace: WorkspaceAggregate) => WorkspaceAggregate) {
    const workspace = await registry.getById(workspaceID)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceID}`)
    const updated = await upsertAndPublish(updater(workspace))
    if (updated.lifecycleState !== workspace.lifecycleState) {
      await Bus.publish(WorkspaceEvent.LifecycleChanged, {
        workspace: updated,
        previous: workspace,
        previousState: workspace.lifecycleState,
        nextState: updated.lifecycleState,
      })
    }
    return updated
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
      return upsertAndPublish(workspace)
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
    markResetting(input) {
      return updateLifecycle(input.workspaceID, markWorkspaceResetting)
    },
    markDeleting(input) {
      return updateLifecycle(input.workspaceID, markWorkspaceDeleting)
    },
    markArchived(input) {
      return updateLifecycle(input.workspaceID, markWorkspaceArchived)
    },
    markActive(input) {
      return updateLifecycle(input.workspaceID, markWorkspaceActive)
    },
    markFailed(input) {
      return updateLifecycle(input.workspaceID, markWorkspaceFailed)
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
    async attachWorker(input) {
      const session = await Session.get(input.sessionID)
      workerDirectoryById.set(input.workerID, normalizeWorkspaceDirectory(session.directory))
      return updateAttachments(session.directory, (descriptors) => {
        const next = descriptors.filter((item) => !(item.type === "worker" && item.key === input.workerID))
        next.push({
          type: "worker",
          ownership: "workspace",
          key: input.workerID,
        })
        return next
      })
    },
    async detachWorker(input) {
      const directory = input.directory ?? workerDirectoryById.get(input.workerID)
      if (!directory) return undefined
      workerDirectoryById.delete(input.workerID)
      return updateAttachments(directory, (descriptors) =>
        descriptors.filter((item) => !(item.type === "worker" && item.key === input.workerID)),
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
      Bus.subscribe(TaskWorkerEvent.Assigned, (evt) => {
        void this.attachWorker({ workerID: evt.properties.workerID, sessionID: evt.properties.sessionID })
      })
      Bus.subscribe(TaskWorkerEvent.Done, (evt) => {
        void this.detachWorker({ workerID: evt.properties.workerID })
      })
      Bus.subscribe(TaskWorkerEvent.Failed, (evt) => {
        void this.detachWorker({ workerID: evt.properties.workerID })
      })
      Bus.subscribe(TaskWorkerEvent.Removed, (evt) => {
        void this.detachWorker({ workerID: evt.properties.workerID })
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
