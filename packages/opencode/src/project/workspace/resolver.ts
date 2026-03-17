import { Project } from "../project"
import { createEmptyWorkspaceAttachmentSummary } from "./attachments"
import { DEFAULT_LANE_POLICY } from "./types"
import type { WorkspaceAggregate, WorkspaceKind, WorkspaceLocator, WorkspaceOrigin } from "./types"
import { createWorkspaceId, normalizeWorkspaceDirectory } from "./identity"

function defaultOriginForKind(kind: WorkspaceKind): WorkspaceOrigin {
  if (kind === "sandbox") return "generated"
  return "local"
}

function buildWorkspace(args: {
  projectId: string
  directory: string
  kind: WorkspaceKind
  displayName?: string
  branch?: string
  origin?: WorkspaceOrigin
}): WorkspaceAggregate {
  const directory = normalizeWorkspaceDirectory(args.directory)
  const locator: WorkspaceLocator = {
    directory,
    projectId: args.projectId,
    kind: args.kind,
  }
  return {
    workspaceId: createWorkspaceId(locator),
    ...locator,
    origin: args.origin ?? defaultOriginForKind(args.kind),
    lifecycleState: "active",
    displayName: args.displayName,
    branch: args.branch,
    attachments: createEmptyWorkspaceAttachmentSummary(),
    lanePolicy: { ...DEFAULT_LANE_POLICY },
    killSwitchScope: "global",
  }
}

export function buildRootWorkspace(args: {
  projectId: string
  directory: string
  displayName?: string
  branch?: string
  origin?: WorkspaceOrigin
}) {
  return buildWorkspace({ ...args, kind: "root", origin: args.origin ?? "local" })
}

export function buildSandboxWorkspace(args: {
  projectId: string
  directory: string
  displayName?: string
  branch?: string
  origin?: WorkspaceOrigin
}) {
  return buildWorkspace({ ...args, kind: "sandbox", origin: args.origin ?? "generated" })
}

export function buildDerivedWorkspace(args: {
  projectId: string
  directory: string
  displayName?: string
  branch?: string
  origin?: WorkspaceOrigin
}) {
  return buildWorkspace({ ...args, kind: "derived", origin: args.origin ?? "local" })
}

export function resolveWorkspaceFromProject(input: { project: Project.Info; directory: string }) {
  const directory = normalizeWorkspaceDirectory(input.directory)
  const root = normalizeWorkspaceDirectory(input.project.worktree)
  if (directory === root) {
    return buildRootWorkspace({
      projectId: input.project.id,
      directory,
      displayName: input.project.name,
    })
  }

  const sandboxes = (input.project.sandboxes ?? []).map(normalizeWorkspaceDirectory)
  if (sandboxes.includes(directory)) {
    return buildSandboxWorkspace({
      projectId: input.project.id,
      directory,
    })
  }

  return buildDerivedWorkspace({
    projectId: input.project.id,
    directory,
  })
}

export type ResolveWorkspaceInput = {
  directory: string
}

export async function resolveWorkspace(input: ResolveWorkspaceInput): Promise<WorkspaceAggregate> {
  const directory = normalizeWorkspaceDirectory(input.directory)
  const { project } = await Project.fromDirectory(directory)
  return resolveWorkspaceFromProject({ project, directory })
}

export async function resolveWorkspaceWithRegistry(input: {
  directory: string
  registry: import("./registry").WorkspaceRegistry
}): Promise<WorkspaceAggregate> {
  const directory = normalizeWorkspaceDirectory(input.directory)
  const existing = await input.registry.getByDirectory(directory)
  if (existing) return existing
  const resolved = await resolveWorkspace({ directory })
  return input.registry.upsert(resolved)
}
