import { test, expect, describe } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import { tmpdir } from "../fixture/fixture"
import { NodeFS } from "../../src/freerun/storage/node-fs"
import { nodeFilePath, sessionStorageDir, type ContextNode } from "../../src/freerun/types"

function mkNode(overrides: Partial<ContextNode> = {}): ContextNode {
  return {
    id: "root",
    parent_id: null,
    children_ids: [],
    title: "Root node",
    body: "",
    mode: "pending-plan",
    created_at: "2026-05-26T22:00:00.000Z",
    iteration_count: 0,
    observations: [],
    decisions: [],
    blockers: [],
    results: null,
    next_intent: "",
    consolidated_summary: null,
    ...overrides,
  }
}

describe("freerun NodeFS", () => {
  test("serialize/deserialize round-trip preserves all fields", () => {
    const node = mkNode({
      id: "root.plan-a",
      parent_id: "root",
      children_ids: ["root.plan-a.s1", "root.plan-a.s2"],
      title: 'Plan "A" — handles : and \\ chars',
      body: "First-line description.\n\nSecond paragraph with `code` and a ``` fence-like sequence (not real).",
      mode: "doing",
      updated_at: "2026-05-26T22:05:00.000Z",
      iteration_count: 3,
      observations: ["saw file at /tmp/x", "second observation"],
      decisions: [{ decision: "use atomic write", rationale: "POSIX rename guarantee on same fs" }],
      blockers: ["awaiting parent input"],
      results: { ok: true, count: 42 },
      next_intent: "drain pending children",
      consolidated_summary: null,
      relevant_tools: ["bash", "read"],
      relevant_skills: [],
    })
    const text = NodeFS.serialize(node)
    const back = NodeFS.deserialize(text)
    expect(back).toEqual(node)
  })

  test("serialize emits stable shape", () => {
    const node = mkNode()
    const text = NodeFS.serialize(node)
    // Frontmatter open + close
    expect(text.startsWith("---\n")).toBe(true)
    expect(text).toContain("\n---\n")
    // State fence
    expect(text).toContain("```json freerun-state")
    expect(text.trim().endsWith("```")).toBe(true)
  })

  test("deserialize rejects missing frontmatter open", () => {
    expect(() => NodeFS.deserialize("no frontmatter here")).toThrow(/missing opening/)
  })

  test("deserialize rejects unclosed frontmatter", () => {
    expect(() => NodeFS.deserialize("---\nid: \"x\"\nno close")).toThrow(/missing closing/)
  })

  test("deserialize rejects missing state fence", () => {
    const txt = '---\nid: "x"\nparent_id: null\nchildren_ids: []\ntitle: "t"\nmode: "pending-plan"\ncreated_at: "2026-05-26T22:00:00.000Z"\niteration_count: 0\n---\n\nbody only no fence'
    expect(() => NodeFS.deserialize(txt)).toThrow(/state fence/)
  })

  test("write/read round-trip on real fs", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const dataHome = tmp.path
    const sessionId = "ses-test-001"
    const node = mkNode({ id: "root.exec.1", title: "Execute step 1", mode: "pending-exec" })
    await NodeFS.write(sessionId, node, dataHome)

    const expectedPath = nodeFilePath(sessionId, node.id, dataHome)
    expect(await Bun.file(expectedPath).exists()).toBe(true)

    const back = await NodeFS.read(sessionId, node.id, dataHome)
    expect(back).toEqual(node)
  })

  test("list returns node ids only, ignores .archive and non-md files", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const dataHome = tmp.path
    const sessionId = "ses-list-test"
    await NodeFS.write(sessionId, mkNode({ id: "root" }), dataHome)
    await NodeFS.write(sessionId, mkNode({ id: "root.a", parent_id: "root" }), dataHome)
    await NodeFS.write(sessionId, mkNode({ id: "root.b", parent_id: "root" }), dataHome)
    // Dropped junk file that should be ignored.
    await Bun.write(path.join(sessionStorageDir(sessionId, dataHome), "tree", "README.txt"), "noise")
    const ids = (await NodeFS.list(sessionId, dataHome)).sort()
    expect(ids).toEqual(["root", "root.a", "root.b"])
  })

  test("exists returns false for missing node, true for present", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const dataHome = tmp.path
    const sessionId = "ses-exists-test"
    expect(await NodeFS.exists(sessionId, "root", dataHome)).toBe(false)
    await NodeFS.write(sessionId, mkNode({ id: "root" }), dataHome)
    expect(await NodeFS.exists(sessionId, "root", dataHome)).toBe(true)
    expect(await NodeFS.exists(sessionId, "ghost", dataHome)).toBe(false)
  })

  test("archive moves node file into tree/.archive/<stamp>/", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const dataHome = tmp.path
    const sessionId = "ses-archive-test"
    await NodeFS.write(sessionId, mkNode({ id: "root.x" }), dataHome)
    const stamp = "2026-05-26T22-10-00Z"
    await NodeFS.archive(sessionId, "root.x", stamp, dataHome)

    expect(await NodeFS.exists(sessionId, "root.x", dataHome)).toBe(false)
    const archivePath = path.join(sessionStorageDir(sessionId, dataHome), "tree", ".archive", stamp, "root.x.md")
    expect(await Bun.file(archivePath).exists()).toBe(true)

    // list() ignores .archive
    const ids = await NodeFS.list(sessionId, dataHome)
    expect(ids).toEqual([])
  })

  test("write rejects malformed node (schema validation)", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const dataHome = tmp.path
    const bad: any = mkNode({ id: "ROOT-UPPERCASE" }) // violates id regex
    await expect(NodeFS.write("ses-bad", bad, dataHome)).rejects.toThrow()
  })

  test("temp file does not linger after successful write", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const dataHome = tmp.path
    const sessionId = "ses-tmp-test"
    await NodeFS.write(sessionId, mkNode({ id: "root" }), dataHome)
    const treeDir = path.join(sessionStorageDir(sessionId, dataHome), "tree")
    const entries = await fs.readdir(treeDir)
    const tmpFiles = entries.filter((e) => e.endsWith(".tmp"))
    expect(tmpFiles).toEqual([])
  })
})
