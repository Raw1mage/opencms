import { describe, expect, test } from "bun:test"
import { reconcileTabsForOperation, reconcileContentForOperation } from "./reconcile"

const fileTab = (relPath: string) => `file://${encodeURI(relPath)}`
const pathFromTab = (tab: string) => (tab.startsWith("file://") ? decodeURI(tab.slice("file://".length)) : undefined)

describe("reconcileTabsForOperation", () => {
  test("rename rebinds the matching tab and any descendant tabs", () => {
    const tabs = [fileTab("docs/old.txt"), fileTab("docs/sub/x.md"), fileTab("other.txt"), "review"]
    const result = reconcileTabsForOperation(
      tabs,
      tabs[0],
      { operation: "rename", source: "docs/old.txt", destination: "docs/new.txt" },
      pathFromTab,
      fileTab,
    )
    expect(result.kept).toEqual([fileTab("docs/new.txt"), fileTab("docs/sub/x.md"), fileTab("other.txt"), "review"])
    expect(result.rebound).toEqual([{ from: fileTab("docs/old.txt"), to: fileTab("docs/new.txt") }])
    expect(result.closed).toEqual([])
    expect(result.activeRebind).toBe(fileTab("docs/new.txt"))
  })

  test("move of a directory rebinds every descendant tab", () => {
    const tabs = [fileTab("docs/a.txt"), fileTab("docs/sub/b.txt"), fileTab("unrelated.txt")]
    const result = reconcileTabsForOperation(
      tabs,
      tabs[1],
      { operation: "move", source: "docs", destination: "archive/docs" },
      pathFromTab,
      fileTab,
    )
    expect(result.kept).toEqual([
      fileTab("archive/docs/a.txt"),
      fileTab("archive/docs/sub/b.txt"),
      fileTab("unrelated.txt"),
    ])
    expect(result.rebound.length).toBe(2)
    expect(result.activeRebind).toBe(fileTab("archive/docs/sub/b.txt"))
  })

  test("delete drops the matching tab plus descendants and picks left neighbor as active", () => {
    const tabs = [fileTab("a.txt"), fileTab("docs/x.txt"), fileTab("docs/sub/y.txt"), fileTab("z.txt")]
    const result = reconcileTabsForOperation(
      tabs,
      fileTab("docs/x.txt"),
      { operation: "delete-to-recyclebin", source: "docs" },
      pathFromTab,
      fileTab,
    )
    expect(result.kept).toEqual([fileTab("a.txt"), fileTab("z.txt")])
    expect(result.closed).toEqual([fileTab("docs/x.txt"), fileTab("docs/sub/y.txt")])
    expect(result.activeRebind).toBe(fileTab("a.txt"))
  })

  test("delete falls back to right neighbor when no left survivor exists", () => {
    const tabs = [fileTab("docs/x.txt"), fileTab("a.txt"), fileTab("z.txt")]
    const result = reconcileTabsForOperation(
      tabs,
      fileTab("docs/x.txt"),
      { operation: "delete-to-recyclebin", source: "docs/x.txt" },
      pathFromTab,
      fileTab,
    )
    expect(result.kept).toEqual([fileTab("a.txt"), fileTab("z.txt")])
    expect(result.activeRebind).toBe(fileTab("a.txt"))
  })

  test("delete clears activeRebind when no tabs survive", () => {
    const tabs = [fileTab("docs/x.txt")]
    const result = reconcileTabsForOperation(
      tabs,
      fileTab("docs/x.txt"),
      { operation: "delete-to-recyclebin", source: "docs/x.txt" },
      pathFromTab,
      fileTab,
    )
    expect(result.kept).toEqual([])
    expect(result.activeRebind).toBeUndefined()
  })

  test("non-mutating operations leave the tab list untouched", () => {
    const tabs = [fileTab("a.txt"), "review"]
    for (const operation of ["create-file", "create-directory", "copy", "restore-from-recyclebin", "upload"]) {
      const result = reconcileTabsForOperation(
        tabs,
        tabs[0],
        { operation, source: "a.txt", destination: "b.txt" },
        pathFromTab,
        fileTab,
      )
      expect(result.kept).toEqual(tabs)
      expect(result.rebound).toEqual([])
      expect(result.closed).toEqual([])
    }
  })

  test("non-file tabs are passed through during rename rebind", () => {
    const tabs = ["review", "context", fileTab("a.txt")]
    const result = reconcileTabsForOperation(
      tabs,
      tabs[2],
      { operation: "rename", source: "a.txt", destination: "b.txt" },
      pathFromTab,
      fileTab,
    )
    expect(result.kept).toEqual(["review", "context", fileTab("b.txt")])
  })

  test("active tab unaffected by rebind keeps pointing at its old (still-present) value", () => {
    const tabs = [fileTab("a.txt"), fileTab("docs/old.txt")]
    const result = reconcileTabsForOperation(
      tabs,
      tabs[0],
      { operation: "rename", source: "docs/old.txt", destination: "docs/new.txt" },
      pathFromTab,
      fileTab,
    )
    expect(result.activeRebind).toBeUndefined()
    expect(result.kept[0]).toBe(fileTab("a.txt"))
  })
})

describe("reconcileContentForOperation", () => {
  test("rename emits a rebind from source to destination", () => {
    expect(
      reconcileContentForOperation({ operation: "rename", source: "a.txt", destination: "b.txt" }),
    ).toEqual({ invalidate: [], rebind: [{ from: "a.txt", to: "b.txt" }] })
  })

  test("delete emits an invalidation for the source key", () => {
    expect(reconcileContentForOperation({ operation: "delete-to-recyclebin", source: "a.txt" })).toEqual({
      invalidate: ["a.txt"],
      rebind: [],
    })
  })

  test("create / copy / upload emit no content edits", () => {
    for (const operation of ["create-file", "create-directory", "copy", "restore-from-recyclebin", "upload"]) {
      expect(reconcileContentForOperation({ operation, source: "a", destination: "b" })).toEqual({
        invalidate: [],
        rebind: [],
      })
    }
  })

  test("missing source short-circuits", () => {
    expect(reconcileContentForOperation({ operation: "rename", destination: "b.txt" })).toEqual({
      invalidate: [],
      rebind: [],
    })
  })
})
