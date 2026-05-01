import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SessionStorage } from "../session/storage"

const { Tweaks } = await import("../config/tweaks")
const { routeSubagentResultForNotice, setSubagentResultAttachmentWriterForTesting } = await import("./task")

const ENV_KEY = "OPENCODE_TWEAKS_PATH"
const storedBlobs: SessionStorage.AttachmentBlob[] = []
let tmpDir: string
let prevEnv: string | undefined
let storageFailure: Error | undefined

async function configureBoundary() {
  const path = join(tmpDir, "tweaks.cfg")
  writeFileSync(path, "boundary_subagent_result_max_bytes=1024\nboundary_attachment_preview_bytes=32\n", "utf8")
  process.env[ENV_KEY] = path
  Tweaks.resetForTesting()
  await Tweaks.loadEffective()
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "task-subagent-result-test-"))
  prevEnv = process.env[ENV_KEY]
  storedBlobs.length = 0
  storageFailure = undefined
  setSubagentResultAttachmentWriterForTesting({
    upsertAttachmentBlob: async (blob: SessionStorage.AttachmentBlob) => {
      if (storageFailure) throw storageFailure
      storedBlobs.push(blob)
    },
  })
  await configureBoundary()
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = prevEnv
  Tweaks.resetForTesting()
  setSubagentResultAttachmentWriterForTesting()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("routeSubagentResultForNotice", () => {
  it("keeps small subagent results inline", async () => {
    const result = await routeSubagentResultForNotice({
      parentSessionID: "ses_parenttasktest000000000",
      parentMessageID: "msg_parenttasktest000000000",
      childSessionID: "ses_childtasktest0000000000",
      raw: "small result",
    })

    expect(result).toEqual({ type: "inline", text: "small result", byteSize: 12, estTokens: 3 })
    expect(storedBlobs.length).toBe(0)
  })

  it("stores oversized subagent results by reference with TLDR preview", async () => {
    const raw = "TLDR: finished the migration\n" + "A".repeat(2048)
    const result = await routeSubagentResultForNotice({
      parentSessionID: "ses_parenttasktest000000000",
      parentMessageID: "msg_parenttasktest000000000",
      childSessionID: "ses_childtasktest0000000000",
      raw,
    })

    expect(result?.type).toBe("attachment_ref")
    expect(result?.preview).toBe("TLDR: finished the migration")
    expect(result?.byteSize).toBe(Buffer.byteLength(raw, "utf8"))
    expect(storedBlobs.length).toBe(1)
    expect(storedBlobs[0].sessionID).toBe("ses_parenttasktest000000000")
    expect(storedBlobs[0].messageID).toBe("msg_parenttasktest000000000")
    expect(storedBlobs[0].filename).toBe("subagent-ses_childtasktest0000000000-result.txt")
    expect(Buffer.from(storedBlobs[0].content).toString("utf8")).toBe(raw)
  })

  it("uses an explicit no-preview stub instead of raw-prefix fallback", async () => {
    const raw = "B".repeat(2048)
    const result = await routeSubagentResultForNotice({
      parentSessionID: "ses_parenttasktest000000000",
      parentMessageID: "msg_parenttasktest000000000",
      childSessionID: "ses_childtasktest0000000000",
      raw,
    })

    expect(result?.type).toBe("attachment_ref")
    expect(result?.preview).toBe("[preview unavailable; full subagent result stored by reference]")
    expect(result?.preview).not.toContain("BBBB")
  })

  it("propagates storage failure instead of returning raw oversized content", async () => {
    storageFailure = new Error("store failed")
    await expect(
      routeSubagentResultForNotice({
        parentSessionID: "ses_parenttasktest000000000",
        parentMessageID: "msg_parenttasktest000000000",
        childSessionID: "ses_childtasktest0000000000",
        raw: "TLDR: should not raw fallback\n" + "C".repeat(2048),
      }),
    ).rejects.toThrow("store failed")
    expect(storedBlobs.length).toBe(0)
  })
})
