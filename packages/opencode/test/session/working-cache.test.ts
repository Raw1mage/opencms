import { afterEach, describe, expect, test } from "bun:test"
import { WorkingCache } from "../../src/session/working-cache"
import { PostCompaction } from "../../src/session/post-compaction"
import { Storage } from "../../src/storage/storage"

function validEntry(overrides: Partial<WorkingCache.EntryInput> = {}): WorkingCache.EntryInput {
  return {
    id: "wc_test_1",
    version: 1,
    scope: { kind: "session", sessionID: "ses_test" },
    purpose: "capture reusable exploration digest",
    facts: [
      {
        text: "Working Cache stores digest, not raw tool output.",
        evidenceRefs: ["E1"],
        confidence: "high",
      },
    ],
    evidence: [
      {
        id: "E1",
        path: "tool/read/result/1",
        kind: "tool-result",
        // freshness signal required after working-cache plan revision DD-12 / INV-6 —
        // sha256 is sufficient on its own for tool-result evidence.
        sha256: "0000000000000000000000000000000000000000000000000000000000000001",
      },
    ],
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    operation: "read",
    ...overrides,
  }
}

function createStore() {
  const data = new Map<string, unknown>()
  return {
    data,
    store: {
      async read<T>(key: string[]) {
        const joined = key.join("/")
        if (!data.has(joined)) throw new Storage.NotFoundError({ message: "not found" })
        return data.get(joined) as T
      },
      async write<T>(key: string[], content: T) {
        data.set(key.join("/"), content)
      },
    },
  }
}

afterEach(() => {
  WorkingCache.setStoreForTesting()
})

describe("WorkingCache", () => {
  test("record validates and writes entry plus scoped index", async () => {
    const { data, store } = createStore()
    WorkingCache.setStoreForTesting(store)

    const recorded = await WorkingCache.record(validEntry())

    expect(recorded.id).toBe("wc_test_1")
    expect(data.get("working_cache/entry/wc_test_1")).toEqual(recorded)
    expect(data.get("working_cache/index/session:ses_test")).toMatchObject({
      version: 1,
      entries: ["wc_test_1"],
    })
  })

  test("record rejects entries without usable evidence", async () => {
    const { data, store } = createStore()
    WorkingCache.setStoreForTesting(store)

    const candidate = validEntry({
      facts: [{ text: "Missing evidence is unsafe.", evidenceRefs: ["missing"] }],
    })

    await expect(WorkingCache.record(candidate)).rejects.toThrow(WorkingCache.WorkingCacheError)
    await expect(WorkingCache.record(candidate)).rejects.toThrow("Fact references missing evidence")
    expect(data.size).toBe(0)
  })

  test("selectValid prefers latest modifying ledger entry and keeps lineage", async () => {
    const { store } = createStore()
    WorkingCache.setStoreForTesting(store)

    await WorkingCache.record(validEntry({ id: "wc_read", operation: "read" }))
    await WorkingCache.record(
      validEntry({
        id: "wc_modify",
        operation: "modify",
        derivedFrom: ["wc_read"],
        supersedes: ["wc_read"],
        updatedAt: "2026-05-07T00:01:00.000Z",
      }),
    )

    const selected = await WorkingCache.selectValid({ kind: "session", sessionID: "ses_test" })

    expect(selected.entries.map((entry) => entry.id)).toEqual(["wc_modify"])
    expect(selected.entries[0].derivedFrom).toEqual(["wc_read"])
  })

  test("renderForRecovery includes evidence and lineage", () => {
    const rendered = WorkingCache.renderForRecovery([
      WorkingCache.validate(
        validEntry({
          id: "wc_modify",
          operation: "modify",
          derivedFrom: ["wc_read"],
          supersedes: ["wc_read"],
        }),
      ),
    ])

    expect(rendered).toContain("evidence: E1")
    expect(rendered).toContain("derivedFrom:wc_read")
    expect(rendered).toContain("supersedes:wc_read")
  })

  test("post-compaction provider emits manifest-form awareness", async () => {
    const { store } = createStore()
    WorkingCache.setStoreForTesting(store)

    await WorkingCache.record(
      validEntry({
        id: "wc_recovery",
        operation: "modify",
        purpose: "Working Cache manifest contract",
        summary: "Provider should expose only counts + topic labels, not the body.",
      }),
    )

    const followUps = await PostCompaction.gather("ses_test")
    const workingCache = followUps.find((item) => item.title === "Working Cache (awareness manifest)")

    expect(workingCache?.summaryBody).toContain("Working Cache: L2=0")
    expect(workingCache?.summaryBody).toContain("L1=1 digests")
    expect(workingCache?.summaryBody).toContain("Working Cache manifest contract")
    expect(workingCache?.summaryBody).not.toContain("Provider should expose only counts")
    expect(workingCache?.summaryBody).toContain("system-manager:recall_toolcall_index")
    expect(workingCache?.continueHint).toContain("L1 digests")
    expect(workingCache?.continueHint).toContain("system-manager:recall_toolcall_raw")
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Plan revision tests — L2 ledger derivation, manifest, parser, depth counter.
  // ─────────────────────────────────────────────────────────────────────────

  function syntheticToolMessage(
    messageID: string,
    parts: Array<{
      tool: string
      callID: string
      input?: Record<string, unknown>
      output?: string
      timeStartMs?: number
    }>,
  ) {
    return {
      info: { id: messageID, role: "assistant" as const },
      parts: parts.map((p, i) => ({
        id: `${messageID}_p${i}`,
        sessionID: "ses_test",
        messageID,
        type: "tool" as const,
        callID: p.callID,
        tool: p.tool,
        state: {
          status: "completed" as const,
          input: p.input ?? {},
          output: p.output ?? "",
          title: p.tool,
          metadata: {},
          time: { start: p.timeStartMs ?? Date.now(), end: (p.timeStartMs ?? Date.now()) + 1 },
        },
      })),
    } as any
  }

  test("deriveLedger pulls pointer-only entries from completed ToolParts", () => {
    const messages = [
      syntheticToolMessage("msg_1", [
        { tool: "read", callID: "tc_1", input: { filePath: "src/a.ts" }, output: "console.log('a')" },
        { tool: "grep", callID: "tc_2", input: { pattern: "todo" }, output: "src/a.ts:1: todo" },
      ]),
      syntheticToolMessage("msg_2", [
        { tool: "edit", callID: "tc_3", input: { filePath: "src/a.ts" }, output: "edited" },
      ]),
    ]

    const ledger = WorkingCache.deriveLedger(messages)

    expect(ledger).toHaveLength(3)
    expect(ledger[0]).toMatchObject({
      toolCallID: "tc_1",
      toolName: "read",
      kind: "exploration",
      filePath: "src/a.ts",
      messageRef: "msg_1",
      turn: 0,
    })
    expect(ledger[2]).toMatchObject({
      toolCallID: "tc_3",
      toolName: "edit",
      kind: "modify",
      messageRef: "msg_2",
      turn: 1,
    })
    // Pointer-only: entries must not carry a `body` / raw output field.
    expect(Object.keys(ledger[0])).not.toContain("body")
    expect(Object.keys(ledger[0])).not.toContain("output")
    // outputHash is included as a freshness signal (sha256 of output text).
    expect(ledger[0].outputHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test("selectLedger filters by kind / path / turn range", () => {
    const messages = [
      syntheticToolMessage("msg_1", [
        { tool: "read", callID: "tc_1", input: { filePath: "src/a.ts" }, output: "a" },
      ]),
      syntheticToolMessage("msg_2", [
        { tool: "read", callID: "tc_2", input: { filePath: "src/b.ts" }, output: "b" },
        { tool: "edit", callID: "tc_3", input: { filePath: "src/a.ts" }, output: "edited" },
      ]),
    ]
    const ledger = WorkingCache.deriveLedger(messages)

    expect(WorkingCache.selectLedger(ledger, { path: "src/a.ts" })).toHaveLength(2)
    expect(WorkingCache.selectLedger(ledger, { path: "src/c.ts" })).toHaveLength(0)
    expect(WorkingCache.selectLedger(ledger, { kind: "exploration" })).toHaveLength(2)
    expect(WorkingCache.selectLedger(ledger, { kind: "modify" })).toHaveLength(1)
    expect(WorkingCache.selectLedger(ledger, { turnRangeStart: 1 }).every((e) => e.turn >= 1)).toBe(true)
  })

  test("buildManifest + renderManifest stay under 120 token budget", () => {
    const messages = [
      syntheticToolMessage(
        "msg_1",
        Array.from({ length: 25 }, (_, i) => ({
          tool: i % 3 === 0 ? "grep" : "read",
          callID: `tc_${i}`,
          input: { filePath: `src/file_${i}.ts` },
          output: "x".repeat(50),
        })),
      ),
    ]
    const ledger = WorkingCache.deriveLedger(messages)
    const manifest = WorkingCache.buildManifest(ledger, [])
    expect(manifest.l2.total).toBe(25)
    expect(manifest.l1.total).toBe(0)
    const rendered = WorkingCache.renderManifest(manifest)
    // 480 chars / 4 = 120 tokens budget
    expect(rendered.length).toBeLessThanOrEqual(480)
    expect(rendered).toContain("L2=25")
    expect(rendered).toContain("system-manager:recall_toolcall_index")
  })

  test("parseDigestBlocks accepts well-formed JSON block", () => {
    const text = [
      "Some prose before.",
      "```cache-digest",
      JSON.stringify({
        purpose: "ledger derivation walks ToolPart records",
        facts: [{ text: "deriveLedger emits one entry per completed ToolPart", evidenceRefs: ["E1"] }],
        evidence: [
          {
            id: "E1",
            path: "packages/opencode/src/session/working-cache.ts",
            kind: "file",
            mtimeMs: 1234567890000,
          },
        ],
      }),
      "```",
      "Some prose after.",
    ].join("\n")

    const parsed = WorkingCache.parseDigestBlocks(text, "ses_test")
    expect(parsed).toHaveLength(1)
    expect(parsed[0].entry).not.toBeNull()
    expect(parsed[0].error).toBeUndefined()
    expect(parsed[0].entry!.purpose).toBe("ledger derivation walks ToolPart records")
    expect(parsed[0].entry!.scope).toMatchObject({ kind: "session", sessionID: "ses_test" })
    expect(parsed[0].entry!.id).toMatch(/^wc_[0-9a-f]+$/)
  })

  test("parseDigestBlocks surfaces malformed block as explicit error", () => {
    const text = "```cache-digest\nnot valid json\n```"
    const parsed = WorkingCache.parseDigestBlocks(text, "ses_test")
    expect(parsed).toHaveLength(1)
    expect(parsed[0].entry).toBeNull()
    expect(parsed[0].error?.code).toBe("WORKING_CACHE_DIGEST_BLOCK_MALFORMED")
  })

  test("parseDigestBlocks rejects block with missing required fields", () => {
    const text = ["```cache-digest", JSON.stringify({ purpose: "incomplete" }), "```"].join("\n")
    const parsed = WorkingCache.parseDigestBlocks(text, "ses_test")
    expect(parsed).toHaveLength(1)
    expect(parsed[0].entry).toBeNull()
    // Schema validation error (missing facts / evidence)
    expect(parsed[0].error?.code).toBe("WORKING_CACHE_SCHEMA_INVALID")
  })

  test("exploration depth ticks on exploration tools and resets on modify", () => {
    const sessionID = "ses_depth_test"
    WorkingCache.resetExplorationDepth(sessionID)

    expect(WorkingCache.tickExplorationDepth(sessionID, "exploration")).toBe(1)
    expect(WorkingCache.tickExplorationDepth(sessionID, "exploration")).toBe(2)
    expect(WorkingCache.tickExplorationDepth(sessionID, "other")).toBe(2) // other does not change
    expect(WorkingCache.tickExplorationDepth(sessionID, "exploration")).toBe(3)
    expect(WorkingCache.getExplorationDepth(sessionID)).toBe(3)
    expect(WorkingCache.tickExplorationDepth(sessionID, "modify")).toBe(0)
    expect(WorkingCache.getExplorationDepth(sessionID)).toBe(0)
  })

  test("explorationPostscript fires only at or above threshold", () => {
    expect(WorkingCache.explorationPostscript(0)).toBe("")
    expect(WorkingCache.explorationPostscript(2)).toBe("")
    const at3 = WorkingCache.explorationPostscript(3)
    expect(at3).toContain("[working-cache]")
    expect(at3).toContain("`cache-digest`")
    expect(at3).toContain("Skip emission entirely if no reusable fact crystallised")
  })

  test("validate rejects tool-result evidence missing freshness signal", () => {
    expect(() =>
      WorkingCache.validate({
        ...validEntry(),
        evidence: [
          {
            id: "E1",
            path: "tool/result",
            kind: "tool-result",
            // No sha256, no capturedAt, no max-age trigger → must reject
          },
        ],
      } as any),
    ).toThrow("requires sha256 or (capturedAt + max-age-ms")
  })

  test("validate accepts tool-result evidence with capturedAt + max-age trigger", () => {
    const entry = WorkingCache.validate({
      ...validEntry(),
      evidence: [
        {
          id: "E1",
          path: "tool/result",
          kind: "tool-result",
          capturedAt: new Date().toISOString(),
        },
      ],
      invalidation: [{ type: "max-age-ms", value: 60_000 }],
    } as any)
    expect(entry.evidence[0].capturedAt).toBeTruthy()
  })

  test("Tool.kind classifies common tool ids", async () => {
    const { Tool } = await import("../../src/tool/tool")
    expect(Tool.kind("read")).toBe("exploration")
    expect(Tool.kind("grep")).toBe("exploration")
    expect(Tool.kind("glob")).toBe("exploration")
    expect(Tool.kind("bash")).toBe("exploration")
    expect(Tool.kind("edit")).toBe("modify")
    expect(Tool.kind("write")).toBe("modify")
    expect(Tool.kind("apply_patch")).toBe("modify")
    expect(Tool.kind("todowrite")).toBe("other")
    expect(Tool.kind("nonexistent_tool")).toBe("other")
  })
})
