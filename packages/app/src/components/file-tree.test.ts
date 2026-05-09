import { beforeAll, describe, expect, mock, test } from "bun:test"

let shouldListRoot: typeof import("./file-tree").shouldListRoot
let shouldListExpanded: typeof import("./file-tree").shouldListExpanded
let dirsToExpand: typeof import("./file-tree").dirsToExpand
let fileTreeRowContextMenuTarget: typeof import("./file-tree").fileTreeRowContextMenuTarget
let fileTreeFolderContextMenuTarget: typeof import("./file-tree").fileTreeFolderContextMenuTarget
let fileTreeContextMenuActionGroups: typeof import("./file-tree").fileTreeContextMenuActionGroups

beforeAll(async () => {
  const passthrough = (_type: unknown, props: { children?: unknown }) => props?.children ?? null
  mock.module("@opentui/solid/jsx-runtime", () => ({
    Fragment: (props: { children?: unknown }) => props.children,
    jsx: passthrough,
    jsxs: passthrough,
    jsxDEV: passthrough,
  }))
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@/context/file", () => ({
    useFile: () => ({
      tree: {
        state: () => undefined,
        list: () => Promise.resolve(),
        children: () => [],
        expand: () => {},
        collapse: () => {},
      },
    }),
  }))
  mock.module("@opencode-ai/ui/collapsible", () => ({
    Collapsible: {
      Trigger: (props: { children?: unknown }) => props.children,
      Content: (props: { children?: unknown }) => props.children,
    },
  }))
  const ContextMenuPart = (props: { children?: unknown }) => props.children
  mock.module("@opencode-ai/ui/context-menu", () => ({
    ContextMenu: Object.assign(ContextMenuPart, {
      Trigger: ContextMenuPart,
      Portal: ContextMenuPart,
      Content: ContextMenuPart,
      Group: ContextMenuPart,
      GroupLabel: ContextMenuPart,
      Item: ContextMenuPart,
      ItemLabel: ContextMenuPart,
      ItemDescription: ContextMenuPart,
      Separator: () => null,
    }),
  }))
  mock.module("@opencode-ai/ui/file-icon", () => ({ FileIcon: () => null }))
  mock.module("@opencode-ai/ui/icon", () => ({ Icon: () => null }))
  mock.module("@opencode-ai/ui/tooltip", () => ({ Tooltip: (props: { children?: unknown }) => props.children }))
  const mod = await import("./file-tree")
  shouldListRoot = mod.shouldListRoot
  shouldListExpanded = mod.shouldListExpanded
  dirsToExpand = mod.dirsToExpand
  fileTreeRowContextMenuTarget = mod.fileTreeRowContextMenuTarget
  fileTreeFolderContextMenuTarget = mod.fileTreeFolderContextMenuTarget
  fileTreeContextMenuActionGroups = mod.fileTreeContextMenuActionGroups
})

describe("file tree fetch discipline", () => {
  test("root lists on mount unless already loaded or loading", () => {
    expect(shouldListRoot({ level: 0 })).toBe(true)
    expect(shouldListRoot({ level: 0, dir: { loaded: true } })).toBe(false)
    expect(shouldListRoot({ level: 0, dir: { loading: true } })).toBe(false)
    expect(shouldListRoot({ level: 1 })).toBe(false)
  })

  test("nested dirs list only when expanded and stale", () => {
    expect(shouldListExpanded({ level: 1 })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: false } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true } })).toBe(true)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loaded: true } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loading: true } })).toBe(false)
    expect(shouldListExpanded({ level: 0, dir: { expanded: true } })).toBe(false)
  })

  test("allowed auto-expand picks only collapsed dirs", () => {
    const expanded = new Set<string>()
    const filter = { dirs: new Set(["src", "src/components"]) }

    const first = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(first).toEqual(["src", "src/components"])

    for (const dir of first) expanded.add(dir)

    const second = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(second).toEqual([])
    expect(dirsToExpand({ level: 1, filter, expanded: () => false })).toEqual([])
  })

  test("action groups enable folder destination actions and disable unavailable paste", () => {
    const groups = fileTreeContextMenuActionGroups({
      target: fileTreeFolderContextMenuTarget("src"),
      hasPendingClipboard: false,
    })
    const actions = new Map(groups.flatMap((group) => group.actions.map((action) => [action.id, action])))

    expect(actions.get("create-file")?.enabled).toBe(true)
    expect(actions.get("create-folder")?.enabled).toBe(true)
    expect(actions.get("upload")?.enabled).toBe(true)
    expect(actions.get("paste")?.enabled).toBe(false)
    expect(actions.get("paste")?.reason).toBe("No copied or cut items are pending.")
  })

  test("action groups apply selected-set rules to row targets", () => {
    const node = {
      name: "one.txt",
      path: "src/one.txt",
      absolute: "/repo/src/one.txt",
      type: "file" as const,
      ignored: false,
    }
    const groups = fileTreeContextMenuActionGroups({
      target: fileTreeRowContextMenuTarget(node),
      selection: [
        { path: "src/one.txt", type: "file" },
        { path: "src/two.txt", type: "file" },
      ],
    })
    const actions = new Map(groups.flatMap((group) => group.actions.map((action) => [action.id, action])))

    expect(actions.get("open")?.enabled).toBe(false)
    expect(actions.get("copy")?.label).toBe("Copy 2 items")
    expect(actions.get("cut")?.label).toBe("Cut 2 items")
    expect(actions.get("delete")?.label).toBe("Move 2 items to recyclebin")
    expect(actions.get("rename")?.enabled).toBe(false)
  })

  test("action groups expose restore only for recyclebin rows", () => {
    const node = {
      name: "draft.txt",
      path: "recyclebin/draft.2026-05-09.txt",
      absolute: "/repo/recyclebin/draft.2026-05-09.txt",
      type: "file" as const,
      ignored: false,
    }
    const groups = fileTreeContextMenuActionGroups({ target: fileTreeRowContextMenuTarget(node) })
    const actions = new Map(groups.flatMap((group) => group.actions.map((action) => [action.id, action])))

    expect(actions.get("restore")?.enabled).toBe(true)
    expect(actions.get("download")?.enabled).toBe(true)
  })
})

describe("file tree context menu targets", () => {
  test("row target carries file node identity and parent folder", () => {
    const node = {
      name: "file-tree.tsx",
      path: "packages/app/src/components/file-tree.tsx",
      absolute: "/repo/packages/app/src/components/file-tree.tsx",
      type: "file" as const,
      ignored: false,
    }

    expect(fileTreeRowContextMenuTarget(node)).toEqual({
      kind: "row",
      node,
      path: "packages/app/src/components/file-tree.tsx",
      nodeType: "file",
      parentPath: "packages/app/src/components",
    })
  })

  test("folder/background target carries current folder or root", () => {
    expect(fileTreeFolderContextMenuTarget("src/components")).toEqual({
      kind: "folder",
      path: "src/components",
      parentPath: "src",
    })
    expect(fileTreeFolderContextMenuTarget("")).toEqual({
      kind: "folder",
      path: "",
      parentPath: "",
    })
  })
})
