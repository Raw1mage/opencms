import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SessionStorage } from "../session/storage"

const { Tweaks } = await import("../config/tweaks")
const { AttachmentTool, setAttachmentQueryReaderForTesting } = await import("./attachment")

const ENV_KEY = "OPENCODE_TWEAKS_PATH"
const SID = "ses_attachmenttooltest000000"
let tmpDir: string
let prevEnv: string | undefined
let blobs = new Map<string, SessionStorage.AttachmentBlob>()

function blob(input: Partial<SessionStorage.AttachmentBlob> & { refID: string; mime: string; content: string | Uint8Array }): SessionStorage.AttachmentBlob {
  const content = typeof input.content === "string" ? Uint8Array.from(Buffer.from(input.content, "utf8")) : input.content
  return {
    refID: input.refID,
    sessionID: SID,
    mime: input.mime,
    filename: input.filename,
    byteSize: input.byteSize ?? content.byteLength,
    estTokens: input.estTokens ?? Math.ceil(content.byteLength / 4),
    createdAt: input.createdAt ?? 1700000000000,
    messageID: input.messageID,
    partID: input.partID,
    content,
  }
}

async function execute(args: { ref_id: string; mode?: "digest" | "vision" | "task_result" }) {
  const tool = await AttachmentTool.init()
  return tool.execute(args, {
    sessionID: SID,
    messageID: "msg_attachmenttooltest0000",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: async () => {},
    ask: async () => {},
  })
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "attachment-tool-test-"))
  prevEnv = process.env[ENV_KEY]
  writeFileSync(join(tmpDir, "tweaks.cfg"), "boundary_attachment_preview_bytes=16\n", "utf8")
  process.env[ENV_KEY] = join(tmpDir, "tweaks.cfg")
  Tweaks.resetForTesting()
  await Tweaks.loadEffective()
  blobs = new Map()
  setAttachmentQueryReaderForTesting({
    getAttachmentBlob: async ({ refID }) => {
      const found = blobs.get(refID)
      if (!found) throw new Error("missing ref")
      return found
    },
  })
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = prevEnv
  Tweaks.resetForTesting()
  setAttachmentQueryReaderForTesting()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("AttachmentTool", () => {
  it("returns bounded digest output for text refs", async () => {
    blobs.set("ref_text", blob({ refID: "ref_text", mime: "text/plain", filename: "large.txt", content: "0123456789abcdefRAW_SHOULD_NOT_APPEAR" }))

    const result = await execute({ ref_id: "ref_text" })

    expect(result.metadata.truncated).toBe(true)
    expect(result.output).toContain("0123456789abcdef")
    expect(result.output).not.toContain("RAW_SHOULD_NOT_APPEAR")
    expect(result.output).toContain("raw content remains stored by reference")
  })

  it("throws explicit missing-ref errors", async () => {
    await expect(execute({ ref_id: "ref_missing" })).rejects.toThrow("attachment_ref not found or unreadable")
  })

  it("fails image queries with an explicit vision capability error and no fallback", async () => {
    blobs.set("ref_image", blob({ refID: "ref_image", mime: "image/png", filename: "scan.png", content: Uint8Array.from([1, 2, 3]) }))

    await expect(execute({ ref_id: "ref_image", mode: "vision" })).rejects.toThrow("no vision-capable worker is configured")
  })

  it("drills into task-result refs with bounded preview and metadata", async () => {
    blobs.set(
      "ref_task",
      blob({
        refID: "ref_task",
        mime: "text/plain",
        filename: "subagent-ses_child-result.txt",
        messageID: "msg_parent",
        content: "TLDR: done\n" + "Z".repeat(64),
      }),
    )

    const result = await execute({ ref_id: "ref_task", mode: "task_result" })

    expect(result.metadata.kind).toBe("task_result")
    expect(result.output).toContain('"query": "task_result"')
    expect(result.output).toContain("TLDR: done")
    expect(result.output).not.toContain("ZZZZZZZZZZZZZZZZZZZZ")
  })
})
