import {
  createWorkspaceId as createSharedWorkspaceId,
  deriveWorkspaceKind as deriveSharedWorkspaceKind,
  normalizeWorkspaceDirectory as normalizeSharedWorkspaceDirectory,
} from "@opencode-ai/util/workspace"
import type { WorkspaceKind, WorkspaceLocator } from "./types"

export function normalizeWorkspaceDirectory(directory: string) {
  return normalizeSharedWorkspaceDirectory(directory)
}

export function createWorkspaceId(locator: WorkspaceLocator) {
  return createSharedWorkspaceId(locator)
}

export function deriveWorkspaceKind(input: { directory: string; worktree?: string }): WorkspaceKind {
  return deriveSharedWorkspaceKind(input)
}
