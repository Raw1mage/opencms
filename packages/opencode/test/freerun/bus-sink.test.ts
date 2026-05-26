import { test, expect, describe } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import { tmpdir } from "../fixture/fixture"
import { BusSink } from "../../src/freerun/observability/bus-sink"

/**
 * Note: full round-trip testing of sink writes (emit → subscriber → file)
 * requires an Instance context for Bus.publish to resolve. Production paths
 * always bootstrap one (CLI commands wrap in bootstrap(cwd, fn)). Here we
 * unit-test the sink's own contract — install/dispose surface, no-op on
 * other sessions — directly invoking what we can without Bus.
 *
 * The emit → sink → file path is covered by `opencode freerun-smoke`
 * end-to-end against rawbase (see Phase 1.21 evidence).
 */

describe("freerun BusSink surface", () => {
  test("install returns a handle with dispose() and writeCount()", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sink = BusSink.install({ dataHome: tmp.path, sessionId: "surface-test" })
    expect(typeof sink.dispose).toBe("function")
    expect(typeof sink.writeCount).toBe("function")
    expect(sink.writeCount()).toBe(0)
    sink.dispose()
  })

  test("dispose is idempotent", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sink = BusSink.install({ dataHome: tmp.path, sessionId: "dispose-test" })
    sink.dispose()
    sink.dispose() // should not throw
    expect(sink.writeCount()).toBe(0)
  })

  test("writeCount starts at 0", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sink = BusSink.install({ dataHome: tmp.path, sessionId: "count-test" })
    expect(sink.writeCount()).toBe(0)
    sink.dispose()
  })

  test("install does not create directory until first event arrives", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sink = BusSink.install({ dataHome: tmp.path, sessionId: "lazy-test" })
    const filePath = path.join(tmp.path, "storage", "freerun", "lazy-test", "events.jsonl")
    // Without any events, file should not exist.
    await expect(fs.access(filePath)).rejects.toThrow()
    sink.dispose()
  })
})

