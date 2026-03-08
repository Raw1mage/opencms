import type { WorkspaceAggregate } from "./types"
import { normalizeWorkspaceDirectory } from "./identity"

export interface WorkspaceRegistry {
  getById(workspaceId: string): Promise<WorkspaceAggregate | undefined>
  getByDirectory(directory: string): Promise<WorkspaceAggregate | undefined>
  listByProject(projectId: string): Promise<WorkspaceAggregate[]>
  upsert(workspace: WorkspaceAggregate): Promise<WorkspaceAggregate>
}

class InMemoryWorkspaceRegistry implements WorkspaceRegistry {
  private readonly byId = new Map<string, WorkspaceAggregate>()
  private readonly idByDirectory = new Map<string, string>()

  async getById(workspaceId: string) {
    return this.byId.get(workspaceId)
  }

  async getByDirectory(directory: string) {
    const normalized = normalizeWorkspaceDirectory(directory)
    const id = this.idByDirectory.get(normalized)
    if (!id) return undefined
    return this.byId.get(id)
  }

  async listByProject(projectId: string) {
    return [...this.byId.values()].filter((workspace) => workspace.projectId === projectId)
  }

  async upsert(workspace: WorkspaceAggregate) {
    const normalized = normalizeWorkspaceDirectory(workspace.directory)
    const next = {
      ...workspace,
      directory: normalized,
    }
    this.byId.set(next.workspaceId, next)
    this.idByDirectory.set(normalized, next.workspaceId)
    return next
  }
}

export function createInMemoryWorkspaceRegistry(): WorkspaceRegistry {
  return new InMemoryWorkspaceRegistry()
}
