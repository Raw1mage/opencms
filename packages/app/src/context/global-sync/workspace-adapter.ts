import path from "node:path"

export type WorkspaceAdapterKind = "root" | "sandbox" | "derived"

function trimTrailingSeparators(input: string) {
  const parsed = path.parse(input)
  if (input === parsed.root) return input
  return input.replace(/[\\/]+$/, "")
}

export function normalizeWorkspaceDirectory(directory: string) {
  const normalized = path.normalize(directory)
  return trimTrailingSeparators(normalized)
}

export function deriveWorkspaceKind(input: { directory: string; worktree?: string }): WorkspaceAdapterKind {
  const directory = normalizeWorkspaceDirectory(input.directory)
  const worktree = input.worktree ? normalizeWorkspaceDirectory(input.worktree) : undefined
  if (!worktree) return "derived"
  if (directory === worktree) return "root"
  return "sandbox"
}

export function createWorkspaceId(input: { directory: string; projectId: string; kind: WorkspaceAdapterKind }) {
  const directory = normalizeWorkspaceDirectory(input.directory)
  return `workspace:${Buffer.from(JSON.stringify([input.projectId, input.kind, directory])).toString("base64url")}`
}
