import { describe, expect, test } from "bun:test"
import { parseTasks, findRefillCandidate, phaseToTodoSeed } from "../../src/session/autorun/refill"

/**
 * Phase 6.4 of specs/autonomous-opt-in/ — refill unit tests.
 * Covers the pure-logic layer: markdown parsing, phase selection,
 * and TodoWrite seed generation. The impure `attemptRefill` wrapper
 * is validated via manual verification (§8.3) since mocking
 * fs+Instance is overkill for a path that's 10 lines of glue.
 */

describe("parseTasks", () => {
  test("parses a simple phase with mixed checkbox states", () => {
    const md = [
      "# Tasks",
      "",
      "Some intro prose.",
      "",
      "## 1. First phase",
      "- [ ] 1.1 do a",
      "- [x] 1.2 do b",
      "- [~] 1.3 do c",
      "- [-] 1.4 cancelled item",
      "",
      "## 2. Second phase",
      "- [ ] 2.1 later",
    ].join("\n")
    const phases = parseTasks(md)
    expect(phases.length).toBe(2)
    expect(phases[0]).toMatchObject({ number: 1, title: "First phase" })
    expect(phases[0].items.map((i) => i.status)).toEqual(["pending", "completed", "in_progress", "cancelled"])
    expect(phases[1]).toMatchObject({ number: 2, title: "Second phase" })
    expect(phases[1].items.length).toBe(1)
  })

  test("ignores non-phase headings like ## Revision", () => {
    const md = [
      "## Revision 2026-04-23 — pivot",
      "Some prose here",
      "",
      "## 1. Actual phase",
      "- [ ] 1.1 foo",
    ].join("\n")
    const phases = parseTasks(md)
    expect(phases.length).toBe(1)
    expect(phases[0].title).toBe("Actual phase")
  })

  test("empty markdown returns empty phase list", () => {
    expect(parseTasks("")).toEqual([])
  })

  test("markdown with no phase headings returns empty list", () => {
    const md = "# Tasks\n\nJust prose, no phases.\n"
    expect(parseTasks(md)).toEqual([])
  })

  test("handles items with escaped markdown content (strike-through, links)", () => {
    const md = [
      "## 1. Phase",
      "- [x] 1.1 ~~cancelled idea~~ superseded by 1.2",
      "- [ ] 1.2 [linked](http://example.com) text",
    ].join("\n")
    const phases = parseTasks(md)
    expect(phases[0].items.length).toBe(2)
    expect(phases[0].items[1].content).toContain("[linked]")
  })

  test("tolerates varying whitespace around brackets", () => {
    const md = [
      "## 1. Phase",
      "-  [ ]  1.1  extra spaces",
      "- [x]   1.2 also extra",
    ].join("\n")
    const phases = parseTasks(md)
    expect(phases[0].items.length).toBe(2)
    expect(phases[0].items[0].status).toBe("pending")
    expect(phases[0].items[1].status).toBe("completed")
  })
})

describe("findRefillCandidate", () => {
  test("returns lowest-numbered phase with a pending item", () => {
    const phases = [
      { number: 2, title: "B", items: [{ id: "x", content: "pend", status: "pending" as const }] },
      { number: 1, title: "A", items: [{ id: "y", content: "done", status: "completed" as const }] },
      { number: 3, title: "C", items: [{ id: "z", content: "pend3", status: "pending" as const }] },
    ]
    const cand = findRefillCandidate(phases)
    expect(cand?.number).toBe(2) // phase 1 fully done, phase 2 is next with pending
  })

  test("skips phases with only cancelled items", () => {
    const phases = [
      {
        number: 1,
        title: "A",
        items: [
          { id: "a", content: "cancelled", status: "cancelled" as const },
          { id: "b", content: "also cancelled", status: "cancelled" as const },
        ],
      },
      {
        number: 2,
        title: "B",
        items: [{ id: "c", content: "active", status: "pending" as const }],
      },
    ]
    expect(findRefillCandidate(phases)?.number).toBe(2)
  })

  test("returns null when no phase has pending items", () => {
    const phases = [
      {
        number: 1,
        title: "done",
        items: [{ id: "a", content: "x", status: "completed" as const }],
      },
    ]
    expect(findRefillCandidate(phases)).toBeNull()
  })

  test("returns null on empty phase list", () => {
    expect(findRefillCandidate([])).toBeNull()
  })
})

describe("phaseToTodoSeed", () => {
  test("emits a todo per pending item only", () => {
    const phase = {
      number: 3,
      title: "Phase 3",
      items: [
        { id: "a", content: "todo1", status: "pending" as const },
        { id: "b", content: "todo2-done", status: "completed" as const },
        { id: "c", content: "todo3", status: "pending" as const },
        { id: "d", content: "todo4-inprog", status: "in_progress" as const },
      ],
    }
    const seed = phaseToTodoSeed(phase)
    expect(seed.length).toBe(2)
    expect(seed.map((s) => s.content)).toEqual(["todo1", "todo3"])
    expect(seed.every((s) => s.status === "pending")).toBe(true)
    expect(seed.every((s) => s.priority === "medium")).toBe(true)
  })

  test("phase with no pending items yields empty seed", () => {
    const phase = {
      number: 1,
      title: "P",
      items: [{ id: "a", content: "done", status: "completed" as const }],
    }
    expect(phaseToTodoSeed(phase)).toEqual([])
  })

  test("each emitted todo has a unique id", () => {
    const phase = {
      number: 1,
      title: "P",
      items: [
        { id: "a", content: "1", status: "pending" as const },
        { id: "b", content: "2", status: "pending" as const },
      ],
    }
    const seed = phaseToTodoSeed(phase)
    expect(new Set(seed.map((s) => s.id)).size).toBe(2)
  })
})
