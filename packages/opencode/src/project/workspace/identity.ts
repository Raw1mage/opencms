import path from "node:path"
import type { WorkspaceKind, WorkspaceLocator } from "./types"

function trimTrailingSeparators(input: string) {
  const parsed = path.parse(input)
  if (input === parsed.root) return input
  return input.replace(/[\\/]+$/, "")
}

export function normalizeWorkspaceDirectory(directory: string) {
  const normalized = path.normalize(directory)
  return trimTrailingSeparators(normalized)
}

export function createWorkspaceId(locator: WorkspaceLocator) {
  const normalized = normalizeWorkspaceDirectory(locator.directory)
  return `workspace:${Buffer.from(JSON.stringify([locator.projectId, locator.kind, normalized])).toString("base64url")}`
}

export function deriveWorkspaceKind(input: { directory: string; worktree?: string }): WorkspaceKind {
  const directory = normalizeWorkspaceDirectory(input.directory)
  const worktree = input.worktree ? normalizeWorkspaceDirectory(input.worktree) : undefined
  if (!worktree) return "derived"
  if (directory === worktree) return "root"
  return "sandbox"
}
