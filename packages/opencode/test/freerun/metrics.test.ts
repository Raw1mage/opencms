import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import { readFreerunEventRecords, summarizeFreerunEvents } from "../../src/freerun/observability/metrics"
import { tmpdir } from "../fixture/fixture"

describe("freerun metrics", () => {
  test("summarizes validation and path counters", () => {
    const summary = summarizeFreerunEvents([
      { type: "freerun.iteration.start", properties: {} },
      { type: "freerun.node.stateTransition", properties: {} },
      { type: "freerun.consolidation.performed", properties: {} },
      { type: "freerun.llm.validationRetry", properties: { validationErrors: ["missing meta-ICOM section"] } },
      { type: "freerun.iteration.halted", properties: { errors: ["planner validation failed"] } },
    ])

    expect(summary).toEqual({
      planningValidationFailures: 2,
      noMetaIcomRejects: 1,
      pickNextDecisions: 1,
      nodeTransitions: 1,
      consolidationEvents: 1,
      recentValidationErrors: ["missing meta-ICOM section", "planner validation failed"],
    })
  })

  test("reads events.jsonl and treats missing files as empty", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await expect(readFreerunEventRecords("missing", tmp.path)).resolves.toEqual([])

    const dir = path.join(tmp.path, "storage", "freerun", "status-session")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, "events.jsonl"),
      JSON.stringify({ type: "freerun.iteration.start", properties: { sessionID: "status-session" } }) + "\n",
    )

    await expect(readFreerunEventRecords("status-session", tmp.path)).resolves.toEqual([
      { type: "freerun.iteration.start", properties: { sessionID: "status-session" } },
    ])
  })
})
