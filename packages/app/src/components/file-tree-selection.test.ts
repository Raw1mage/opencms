import { describe, expect, test } from "bun:test"
import {
  applyCheckboxToggle,
  applyRowClick,
  applySelectAllToggle,
  clearSelection,
  emptySelection,
  pruneSelection,
  type SelectionState,
} from "./file-tree-selection"

const seed = (paths: string[], anchor?: string): SelectionState => ({
  selected: new Set(paths),
  anchor,
})

describe("applyRowClick", () => {
  const siblings = ["a", "b", "c", "d", "e"]

  test("plain click replaces selection with a single path", () => {
    const next = applyRowClick(seed(["a", "b"], "a"), "c", siblings, {})
    expect([...next.selected]).toEqual(["c"])
    expect(next.anchor).toBe("c")
  })

  test("ctrl+click adds a path and moves the anchor", () => {
    const next = applyRowClick(seed(["a"], "a"), "c", siblings, { ctrlOrMeta: true })
    expect([...next.selected].sort()).toEqual(["a", "c"])
    expect(next.anchor).toBe("c")
  })

  test("ctrl+click on an already-selected path removes it and keeps the anchor", () => {
    const next = applyRowClick(seed(["a", "c"], "a"), "c", siblings, { ctrlOrMeta: true })
    expect([...next.selected]).toEqual(["a"])
    expect(next.anchor).toBe("a")
  })

  test("shift+click extends a contiguous range from the anchor", () => {
    const next = applyRowClick(seed(["b"], "b"), "d", siblings, { shift: true })
    expect([...next.selected].sort()).toEqual(["b", "c", "d"])
    expect(next.anchor).toBe("b") // anchor stays on shift-click
  })

  test("shift+click works in reverse direction", () => {
    const next = applyRowClick(seed(["d"], "d"), "b", siblings, { shift: true })
    expect([...next.selected].sort()).toEqual(["b", "c", "d"])
  })

  test("shift+click preserves selections from outside the visible siblings", () => {
    const cross = seed(["other-folder/x", "b"], "b")
    const next = applyRowClick(cross, "d", siblings, { shift: true })
    expect([...next.selected].sort()).toEqual(["b", "c", "d", "other-folder/x"])
  })

  test("shift+click without an anchor falls back to plain select-only", () => {
    const next = applyRowClick(seed(["a"]), "c", siblings, { shift: true })
    expect([...next.selected]).toEqual(["c"])
    expect(next.anchor).toBe("c")
  })

  test("shift+click whose anchor is in another folder falls back to plain select-only", () => {
    const next = applyRowClick(seed(["other/x"], "other/x"), "c", siblings, { shift: true })
    expect([...next.selected]).toEqual(["c"])
    expect(next.anchor).toBe("c")
  })

  test("identity preserved when click is a no-op", () => {
    const before = seed(["c"], "c")
    const after = applyRowClick(before, "c", siblings, {})
    expect(after).toBe(before)
  })
})

describe("applyCheckboxToggle", () => {
  test("toggles a path on", () => {
    const next = applyCheckboxToggle(seed([]), "a")
    expect([...next.selected]).toEqual(["a"])
    expect(next.anchor).toBe("a")
  })

  test("toggles a path off without disturbing anchor", () => {
    const next = applyCheckboxToggle(seed(["a", "b"], "a"), "b")
    expect([...next.selected]).toEqual(["a"])
    expect(next.anchor).toBe("a")
  })
})

describe("applySelectAllToggle", () => {
  const siblings = ["a", "b", "c"]

  test("selects every visible sibling and preserves cross-folder selections", () => {
    const next = applySelectAllToggle(seed(["other"]), siblings)
    expect([...next.selected].sort()).toEqual(["a", "b", "c", "other"])
    expect(next.anchor).toBe("c")
  })

  test("clears just the visible siblings when they were all already selected", () => {
    const next = applySelectAllToggle(seed(["a", "b", "c", "other"], "a"), siblings)
    expect([...next.selected]).toEqual(["other"])
    expect(next.anchor).toBe("a")
  })

  test("empty siblings is a no-op", () => {
    const before = seed(["a"], "a")
    const after = applySelectAllToggle(before, [])
    expect(after).toBe(before)
  })
})

describe("clearSelection", () => {
  test("returns identity when already empty", () => {
    const before = emptySelection()
    expect(clearSelection(before)).toBe(before)
  })

  test("drops everything when populated", () => {
    const next = clearSelection(seed(["a", "b"], "a"))
    expect(next.selected.size).toBe(0)
    expect(next.anchor).toBeUndefined()
  })
})

describe("pruneSelection", () => {
  test("drops paths no longer present + clears stale anchor", () => {
    const next = pruneSelection(seed(["a", "b", "c"], "b"), new Set(["a", "c"]))
    expect([...next.selected].sort()).toEqual(["a", "c"])
    expect(next.anchor).toBeUndefined()
  })

  test("returns identity when nothing changed", () => {
    const before = seed(["a", "c"], "c")
    const after = pruneSelection(before, new Set(["a", "c"]))
    expect(after).toBe(before)
  })
})
