import { describe, expect, test } from "bun:test"
import {
  shouldDisarmForKillswitch,
  runDisarmSweep,
  type DisarmSweepDeps,
} from "../../src/session/autorun/observer"

/**
 * Phase 5.4 of specs/autonomous-opt-in/ — disarm observer unit tests.
 * Uses injected deps (runDisarmSweep) so we don't need live Storage.
 */

describe("shouldDisarmForKillswitch", () => {
  test("disarms armed root session", () => {
    expect(
      shouldDisarmForKillswitch({
        workflow: { autonomous: { enabled: true } },
      }),
    ).toBe(true)
  })

  test("skips disarmed session", () => {
    expect(
      shouldDisarmForKillswitch({
        workflow: { autonomous: { enabled: false } },
      }),
    ).toBe(false)
  })

  test("skips subagent (parentID present) even when armed", () => {
    expect(
      shouldDisarmForKillswitch({
        parentID: "ses_parent",
        workflow: { autonomous: { enabled: true } },
      }),
    ).toBe(false)
  })

  test("skips session with no workflow metadata (pre-arm state)", () => {
    expect(shouldDisarmForKillswitch({})).toBe(false)
  })
})

function makeDeps(
  sessions: Array<{
    id: string
    parentID?: string | null
    workflow?: { autonomous: { enabled: boolean } }
  }>,
  updateErrors: Record<string, Error> = {},
): { deps: DisarmSweepDeps; updated: string[] } {
  const updated: string[] = []
  const deps: DisarmSweepDeps = {
    list: async function* () {
      for (const s of sessions) yield s
    },
    update: async (sessionID: string) => {
      if (updateErrors[sessionID]) throw updateErrors[sessionID]
      updated.push(sessionID)
    },
  }
  return { deps, updated }
}

describe("runDisarmSweep", () => {
  test("flips every armed root session", async () => {
    const { deps, updated } = makeDeps([
      { id: "s1", workflow: { autonomous: { enabled: true } } },
      { id: "s2", workflow: { autonomous: { enabled: true } } },
      { id: "s3", workflow: { autonomous: { enabled: false } } },
    ])
    const result = await runDisarmSweep(deps, "manual_killswitch")
    expect(result).toEqual({ scanned: 3, disarmed: 2 })
    expect(updated.sort()).toEqual(["s1", "s2"])
  })

  test("skips subagents", async () => {
    const { deps, updated } = makeDeps([
      { id: "parent", workflow: { autonomous: { enabled: true } } },
      { id: "child", parentID: "parent", workflow: { autonomous: { enabled: true } } },
    ])
    const result = await runDisarmSweep(deps, "killswitch")
    expect(result).toEqual({ scanned: 2, disarmed: 1 })
    expect(updated).toEqual(["parent"])
  })

  test("zero armed sessions → zero disarms but still scans", async () => {
    const { deps, updated } = makeDeps([
      { id: "a", workflow: { autonomous: { enabled: false } } },
      { id: "b" },
      { id: "c", parentID: "a", workflow: { autonomous: { enabled: true } } },
    ])
    const result = await runDisarmSweep(deps, "killswitch")
    expect(result).toEqual({ scanned: 3, disarmed: 0 })
    expect(updated).toEqual([])
  })

  test("update failure on one session doesn't stop the sweep", async () => {
    const { deps, updated } = makeDeps(
      [
        { id: "s1", workflow: { autonomous: { enabled: true } } },
        { id: "s2", workflow: { autonomous: { enabled: true } } },
        { id: "s3", workflow: { autonomous: { enabled: true } } },
      ],
      { s2: new Error("storage unavailable") },
    )
    const result = await runDisarmSweep(deps, "killswitch")
    expect(result.scanned).toBe(3)
    expect(result.disarmed).toBe(2) // s1 + s3
    expect(updated.sort()).toEqual(["s1", "s3"])
  })

  test("empty session list — scanned 0 disarmed 0", async () => {
    const { deps, updated } = makeDeps([])
    const result = await runDisarmSweep(deps, "killswitch")
    expect(result).toEqual({ scanned: 0, disarmed: 0 })
    expect(updated).toEqual([])
  })
})
