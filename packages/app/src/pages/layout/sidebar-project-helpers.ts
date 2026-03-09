import { workspaceKey } from "./helpers"

export const projectSelected = (currentDir: string, worktree: string, sandboxes?: string[]) => {
  const key = workspaceKey(currentDir)
  return workspaceKey(worktree) === key || sandboxes?.some((sandbox) => workspaceKey(sandbox) === key) === true
}

export const projectTileActive = (args: {
  menu: boolean
  preview: boolean
  open: boolean
  overlay: boolean
  hoverProject?: string
  worktree: string
}) => args.menu || (args.preview ? args.open : args.overlay && args.hoverProject === args.worktree)
