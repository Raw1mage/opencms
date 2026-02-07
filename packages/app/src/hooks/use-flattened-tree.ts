import { createMemo } from "solid-js"
import { useFile } from "@/context/file"
import type { FileNode } from "@opencode-ai/sdk/v2"

export interface FlattenedNode {
  node: FileNode
  depth: number
  expanded: boolean
  hasChildren: boolean
}

export interface TreeFilter {
  files: Set<string>
  dirs: Set<string>
}

export function useFlattenedTree(options: {
  rootPath: string
  allowed?: readonly string[]
}) {
  const file = useFile()

  const filter = createMemo(() => {
    const allowed = options.allowed
    if (!allowed) return

    const files = new Set(allowed)
    const dirs = new Set<string>()

    for (const item of allowed) {
      const parts = item.split("/")
      const parents = parts.slice(0, -1)
      for (const [idx] of parents.entries()) {
        const dir = parents.slice(0, idx + 1).join("/")
        if (dir) dirs.add(dir)
      }
    }

    return { files, dirs }
  })

  const flattened = createMemo(() => {
    const result: FlattenedNode[] = []
    const currentFilter = filter()

    const visit = (path: string, depth: number) => {
      let children = file.tree.children(path)
      
      if (currentFilter) {
        children = children.filter((node) => {
          if (node.type === "file") return currentFilter.files.has(node.path)
          return currentFilter.dirs.has(node.path)
        })
      }

      for (const node of children) {
        const expanded = file.tree.state(node.path)?.expanded ?? false
        const hasChildren = node.type === "directory"

        result.push({
          node,
          depth,
          expanded,
          hasChildren,
        })

        if (node.type === "directory" && expanded) {
          visit(node.path, depth + 1)
        }
      }
    }

    visit(options.rootPath, 0)
    return result
  })

  return flattened
}
