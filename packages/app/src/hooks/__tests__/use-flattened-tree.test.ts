import { describe, expect, test, mock } from "bun:test"
import { createRoot } from "solid-js"
import { useFlattenedTree } from "../use-flattened-tree"

// Mock internal context
const mockTree = {
  "": [
    { path: "src", type: "directory", name: "src" },
    { path: "package.json", type: "file", name: "package.json" },
  ],
  "src": [
    { path: "src/index.ts", type: "file", name: "index.ts" },
    { path: "src/components", type: "directory", name: "components" },
  ],
  "src/components": [
    { path: "src/components/App.tsx", type: "file", name: "App.tsx" },
  ]
}

const mockStates = {
  "": { expanded: true },
  "src": { expanded: true },
  "src/components": { expanded: false },
}

mock.module("@/context/file", () => ({
  useFile: () => ({
    tree: {
      children: (path: string) => mockTree[path as keyof typeof mockTree] ?? [],
      state: (path: string) => mockStates[path as keyof typeof mockStates] ?? { expanded: false },
    },
  }),
}))

describe("useFlattenedTree", () => {
  test("flattens a recursive tree based on expanded state", () => {
    createRoot((dispose) => {
      const flattened = useFlattenedTree({ rootPath: "" })
      const nodes = flattened()

      // Expected:
      // 0: src (depth 0, expanded true)
      // 1: src/index.ts (depth 1)
      // 2: src/components (depth 1, expanded false)
      // 3: package.json (depth 0)
      
      expect(nodes.length).toBe(4)
      
      expect(nodes[0].node.path).toBe("src")
      expect(nodes[0].depth).toBe(0)
      expect(nodes[0].expanded).toBe(true)

      expect(nodes[1].node.path).toBe("src/index.ts")
      expect(nodes[1].depth).toBe(1)

      expect(nodes[2].node.path).toBe("src/components")
      expect(nodes[2].depth).toBe(1)
      expect(nodes[2].expanded).toBe(false)

      expect(nodes[3].node.path).toBe("package.json")
      expect(nodes[3].depth).toBe(0)

      dispose()
    })
  })

  test("filters tree based on allowed list", () => {
    createRoot((dispose) => {
      const flattened = useFlattenedTree({ 
        rootPath: "", 
        allowed: ["src/index.ts", "package.json"] 
      })
      const nodes = flattened()

      // Expected:
      // 0: src (depth 0, expanded true) - included because src/index.ts is inside
      // 1: src/index.ts (depth 1)
      // 2: package.json (depth 0)

      expect(nodes.length).toBe(3)
      expect(nodes.map(n => n.node.path)).toEqual(["src", "src/index.ts", "package.json"])
      
      dispose()
    })
  })
})
