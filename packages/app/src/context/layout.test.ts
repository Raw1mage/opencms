import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  buildProjectRootMap,
  createSessionKeyReader,
  ensureSessionKey,
  migrateLayoutState,
  pruneSessionKeys,
  resolveProjectRoot,
} from "./layout"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})

describe("layout project root helpers", () => {
  test("maps open workspace directories back to canonical project roots", () => {
    const roots = buildProjectRootMap({
      projects: [
        { id: "project-a", worktree: "/repo/a" },
        { id: "project-b", worktree: "/repo/b" },
      ],
      openProjects: ["/repo/a", "/repo/a/feature", "/repo/b/review"],
      resolveProjectID(directory) {
        if (directory.startsWith("/repo/a")) return "project-a"
        if (directory.startsWith("/repo/b")) return "project-b"
        return undefined
      },
    })

    expect(roots.get("/repo/a")).toBe("/repo/a")
    expect(roots.get("/repo/a/feature")).toBe("/repo/a")
    expect(roots.get("/repo/b/review")).toBe("/repo/b")
  })

  test("resolves canonical project root through chained aliases", () => {
    const roots = new Map<string, string>([
      ["/repo/a", "/repo/a"],
      ["/repo/a/feature", "/repo/a"],
      ["/repo/a/feature-copy", "/repo/a/feature"],
    ])

    expect(resolveProjectRoot("/repo/a/feature-copy", roots)).toBe("/repo/a")
    expect(resolveProjectRoot("/repo/unknown", roots)).toBe("/repo/unknown")
  })

  test("guards cyclic root mappings by returning original directory", () => {
    const roots = new Map<string, string>([
      ["/repo/a", "/repo/b"],
      ["/repo/b", "/repo/a"],
    ])

    expect(resolveProjectRoot("/repo/a", roots)).toBe("/repo/a")
  })
})

describe("layout migration defaults", () => {
  test("closes file pane and tool sidebar during persisted layout migration", () => {
    const migrated = migrateLayoutState({
      review: { diffStyle: "split", panelOpened: true },
      fileTree: { opened: true, width: 344, tab: "changes", mode: "changes" },
    }) as {
      review: { panelOpened: boolean }
      fileTree: { opened: boolean; tab: string; mode: string }
    }

    expect(migrated.review.panelOpened).toBe(false)
    expect(migrated.fileTree.opened).toBe(false)
    expect(migrated.fileTree.tab).toBe("changes")
    expect(migrated.fileTree.mode).toBe("changes")
  })
})
