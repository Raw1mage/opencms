import { base64Encode } from "./encode"

export type WorkspaceIdentityKind = "root" | "sandbox" | "derived"

function getWorkspacePathRoot(input: string) {
  if (!input) return ""
  if (/^\/+$/i.test(input)) return "/"
  if (input.startsWith("//")) return "//"
  if (input.startsWith("/")) return "/"
  const drive = input.match(/^[A-Za-z]:\//)
  if (drive) return drive[0]
  return ""
}

function trimTrailingSeparators(input: string) {
  const root = getWorkspacePathRoot(input)
  if (input === root) return input
  return input.replace(/[\\/]+$/, "")
}

export function normalizeWorkspaceDirectory(directory: string) {
  const slashNormalized = directory.replace(/\\+/g, "/")
  const root = getWorkspacePathRoot(slashNormalized)
  const remainder = slashNormalized.slice(root.length)
  const parts = remainder.split(/\/+/).filter(Boolean)
  const normalizedParts: string[] = []

  for (const part of parts) {
    if (part === ".") continue
    if (part === "..") {
      const previous = normalizedParts.at(-1)
      if (previous && previous !== "..") {
        normalizedParts.pop()
        continue
      }
      if (!root) normalizedParts.push(part)
      continue
    }
    normalizedParts.push(part)
  }

  const normalized = root + normalizedParts.join("/")
  return trimTrailingSeparators(normalized)
}

export function deriveWorkspaceKind(input: { directory: string; worktree?: string }): WorkspaceIdentityKind {
  const directory = normalizeWorkspaceDirectory(input.directory)
  const worktree = input.worktree ? normalizeWorkspaceDirectory(input.worktree) : undefined
  if (!worktree) return "derived"
  if (directory === worktree) return "root"
  return "sandbox"
}

export function createWorkspaceId<TKind extends string>(input: { directory: string; projectId: string; kind: TKind }) {
  const directory = normalizeWorkspaceDirectory(input.directory)
  return `workspace:${base64Encode(JSON.stringify([input.projectId, input.kind, directory]))}`
}
