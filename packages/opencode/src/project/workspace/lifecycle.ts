import type { WorkspaceAggregate, WorkspaceLifecycleState } from "./types"

export function transitionWorkspaceLifecycle(input: {
  workspace: WorkspaceAggregate
  next: WorkspaceLifecycleState
}): WorkspaceAggregate {
  return {
    ...input.workspace,
    lifecycleState: input.next,
  }
}

export const markWorkspaceResetting = (workspace: WorkspaceAggregate) =>
  transitionWorkspaceLifecycle({ workspace, next: "resetting" })

export const markWorkspaceDeleting = (workspace: WorkspaceAggregate) =>
  transitionWorkspaceLifecycle({ workspace, next: "deleting" })

export const markWorkspaceArchived = (workspace: WorkspaceAggregate) =>
  transitionWorkspaceLifecycle({ workspace, next: "archived" })

export const markWorkspaceActive = (workspace: WorkspaceAggregate) =>
  transitionWorkspaceLifecycle({ workspace, next: "active" })

export const markWorkspaceFailed = (workspace: WorkspaceAggregate) =>
  transitionWorkspaceLifecycle({ workspace, next: "failed" })
