import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RestartHandover } from "./restart-handover"

describe("RestartHandover.complete build-id handshake (DD-6)", () => {
  let tmpDir: string
  let checkpointPath: string

  const baseCheckpoint = {
    schemaVersion: 1,
    checkpointID: "tx-test",
    txid: "tx-test",
    status: "restart-requested",
    createdAt: new Date().toISOString(),
    pid: 12345,
    runtimeMode: "gateway-daemon",
    targets: ["daemon"],
    validationNextSteps: [],
  }

  async function writeCheckpoint(extra: Record<string, unknown> = {}) {
    await fs.writeFile(checkpointPath, JSON.stringify({ ...baseCheckpoint, ...extra }, null, 2) + "\n", {
      mode: 0o600,
    })
  }

  function completionInput(buildId?: string): RestartHandover.CompletionInput {
    return {
      txid: "tx-test",
      checkpointPath,
      startupLogPath: path.join(tmpDir, "startup.jsonl"),
      pid: 99999,
      ppid: 1,
      buildId,
    }
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "restart-handover-test-"))
    checkpointPath = path.join(tmpDir, "tx-test.json")
    // complete() rewrites pending.json under Global.Path.state (resolved at
    // import time from the test-preload XDG sandbox); ensure the dir exists.
    await fs.mkdir(RestartHandover.dir(), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("TV-10 match: expectedBuildId equals daemon buildId → restart-completed + buildIdCheck=match", async () => {
    await writeCheckpoint({ expectedBuildId: "a1b2c3d.1781228512" })
    const result = await RestartHandover.complete(completionInput("a1b2c3d.1781228512"))
    expect(result.status).toBe("restart-completed")
    expect(result.buildIdCheck).toBe("match")
    expect(result.failureReason).toBeUndefined()
    const onDisk = JSON.parse(await fs.readFile(checkpointPath, "utf8"))
    expect(onDisk.status).toBe("restart-completed")
    expect(onDisk.buildIdCheck).toBe("match")
  })

  it("TV-11 mismatch: expectedBuildId differs → restart-failed + failureReason has expected and actual", async () => {
    await writeCheckpoint({ expectedBuildId: "a1b2c3d.1781228512" })
    const result = await RestartHandover.complete(completionInput("f9e8d7c.1781200000"))
    expect(result.status).toBe("restart-failed")
    expect(result.buildIdCheck).toBe("mismatch")
    expect(result.failureReason).toContain("a1b2c3d.1781228512")
    expect(result.failureReason).toContain("f9e8d7c.1781200000")
    const onDisk = JSON.parse(await fs.readFile(checkpointPath, "utf8"))
    expect(onDisk.status).toBe("restart-failed")
  })

  it("TV-12 legacy: checkpoint without expectedBuildId → restart-completed + buildIdCheck=skipped-legacy", async () => {
    await writeCheckpoint()
    const result = await RestartHandover.complete(completionInput("a1b2c3d.1781228512"))
    expect(result.status).toBe("restart-completed")
    expect(result.buildIdCheck).toBe("skipped-legacy")
    expect(result.failureReason).toBeUndefined()
  })

  it("dev daemon (buildId=local) against expectedBuildId → mismatch (local never satisfies a compiled expectation)", async () => {
    await writeCheckpoint({ expectedBuildId: "a1b2c3d.1781228512" })
    const result = await RestartHandover.complete(completionInput("local"))
    expect(result.status).toBe("restart-failed")
    expect(result.buildIdCheck).toBe("mismatch")
  })

  it("missing buildId in completion against expectedBuildId → mismatch with (none)", async () => {
    await writeCheckpoint({ expectedBuildId: "a1b2c3d.1781228512" })
    const result = await RestartHandover.complete(completionInput(undefined))
    expect(result.status).toBe("restart-failed")
    expect(result.failureReason).toContain("(none)")
  })

  it("txid mismatch still throws regardless of build-id fields", async () => {
    await writeCheckpoint({ txid: "tx-other", checkpointID: "tx-other" })
    await expect(RestartHandover.complete(completionInput("whatever"))).rejects.toThrow("txid mismatch")
  })
})
