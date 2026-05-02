import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SessionStorage } from "../session/storage"

const { Tweaks } = await import("../config/tweaks")
const { AttachmentTool, setAttachmentQueryReaderForTesting, setVisionWorkerRunnerForTesting } = await import(
  "./attachment"
)

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

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

async function execute(args: { ref_id: string; mode?: "digest" | "vision" | "read" | "task_result"; agent?: string; question?: string }) {
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
  setVisionWorkerRunnerForTesting()
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

  it("fails image queries when no vision-capable worker is available", async () => {
    blobs.set("ref_image", blob({ refID: "ref_image", mime: "image/png", filename: "scan.png", content: Uint8Array.from([1, 2, 3]) }))
    setVisionWorkerRunnerForTesting(async () => {
      throw new Error("no vision-capable worker is available for ref_image")
    })

    await expect(execute({ ref_id: "ref_image", mode: "vision" })).rejects.toThrow("no vision-capable worker")
  })

  it("dispatches image refs to the vision worker and returns the digest", async () => {
    blobs.set(
      "ref_image",
      blob({ refID: "ref_image", mime: "image/png", filename: "scan.png", content: Uint8Array.from([1, 2, 3]) }),
    )
    let received: { question: string; mime: string } | undefined
    setVisionWorkerRunnerForTesting(async ({ blob, question }) => {
      received = { question, mime: blob.mime }
      return { providerId: "anthropic", modelID: "claude-haiku-4-5", text: "VISION_DIGEST_TEXT" }
    })

    const result = await execute({ ref_id: "ref_image", mode: "vision", question: "what does it say?" })

    expect(received?.question).toBe("what does it say?")
    expect(received?.mime).toBe("image/png")
    expect(result.metadata.worker).toBe("anthropic/claude-haiku-4-5")
    expect(result.output).toContain("VISION_DIGEST_TEXT")
    expect(result.output).toContain('"query": "read"')
  })

  it("auto-routes mode=digest on image refs through the vision worker", async () => {
    blobs.set(
      "ref_image2",
      blob({ refID: "ref_image2", mime: "image/jpeg", content: Uint8Array.from([9, 8, 7]) }),
    )
    setVisionWorkerRunnerForTesting(async () => ({
      providerId: "codex",
      modelID: "gpt-5.5",
      text: "AUTO_DIGEST",
    }))

    const result = await execute({ ref_id: "ref_image2" })

    expect(result.output).toContain("AUTO_DIGEST")
    expect(result.output).toContain('"query": "read"')
  })

  // /specs/repo-incoming-attachments task 2.6: docx auto-routing through
  // the attachment tool was removed in favour of docxmcp + dispatcher.
  // Users that still want to read docx via the reader-subagent path must
  // pass agent="docx-reader" explicitly. The auto-route assertion is
  // therefore inverted: docx with no explicit agent should refuse rather
  // than silently dispatch to a reader.
  it("docx refs no longer auto-route — explicit agent required", async () => {
    blobs.set(
      "ref_docx",
      blob({
        refID: "ref_docx",
        mime: DOCX_MIME,
        filename: "spec.docx",
        content: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
      }),
    )

    await expect(
      execute({ ref_id: "ref_docx", mode: "read", question: "what is the title?" }),
    ).rejects.toThrow(/no default reader agent/i)
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
