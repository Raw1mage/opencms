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
})
