import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { MessageV2 } from "./message-v2"
import type { SessionStorage } from "./storage"

const storedBlobs: SessionStorage.AttachmentBlob[] = []
let storageFailure: Error | undefined

const { Tweaks } = await import("@/config/tweaks")
const { buildUserMessageParts, setAttachmentBlobWriterForTesting } = await import("./user-message-parts")

const ENV_KEY = "OPENCODE_TWEAKS_PATH"
let tmpDir: string
let prevEnv: string | undefined

function userMessage(): MessageV2.User {
  return {
    id: "msg_userpartstest0000000000",
    sessionID: "ses_userpartstest0000000000",
    role: "user",
    time: { created: 1700000000000 },
    agent: "build",
    model: { providerId: "anthropic", modelID: "claude-test" },
  }
}

function dataTextPart(text: string): Omit<MessageV2.FilePart, "id" | "messageID" | "sessionID"> {
  return {
    type: "file",
    mime: "text/plain",
    filename: "large.txt",
    url: "data:text/plain;base64," + Buffer.from(text).toString("base64"),
  }
}

async function configureBoundary() {
  const path = join(tmpDir, "tweaks.cfg")
  writeFileSync(path, "boundary_user_attachment_max_bytes=1024\nboundary_attachment_preview_bytes=16\n", "utf8")
  process.env[ENV_KEY] = path
  Tweaks.resetForTesting()
  await Tweaks.loadEffective()
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "user-message-parts-test-"))
  prevEnv = process.env[ENV_KEY]
  storedBlobs.length = 0
  storageFailure = undefined
  setAttachmentBlobWriterForTesting({
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
  setAttachmentBlobWriterForTesting()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("buildUserMessageParts oversized attachment routing", () => {
  it("stores oversized data text attachments by reference", async () => {
    const large = "A".repeat(2048)
    const parts = await buildUserMessageParts({
      partsInput: [dataTextPart(large)],
      info: userMessage(),
      sessionID: "ses_userpartstest0000000000",
      agentName: "build",
      agentPermission: {} as any,
    })

    const ref = parts.find((part): part is MessageV2.AttachmentRefPart => part.type === "attachment_ref")
    expect(ref).toBeDefined()
    expect(ref?.mime).toBe("text/plain")
    expect(ref?.byte_size).toBe(2048)
    expect(ref?.preview).toBe("A".repeat(16))
    expect(storedBlobs.length).toBe(1)
    expect(storedBlobs[0].sessionID).toBe("ses_userpartstest0000000000")
    expect(storedBlobs[0].messageID).toBe("msg_userpartstest0000000000")
    expect(Buffer.from(storedBlobs[0].content).toString("utf8")).toBe(large)
    expect(parts.some((part) => part.type === "text" && part.text === large)).toBe(false)
  })

  it("preserves small data attachments without storing refs", async () => {
    const parts = await buildUserMessageParts({
      partsInput: [dataTextPart("small")],
      info: userMessage(),
      sessionID: "ses_userpartstest0000000000",
      agentName: "build",
      agentPermission: {} as any,
    })

    expect(parts.some((part) => part.type === "attachment_ref")).toBe(false)
    expect(storedBlobs.length).toBe(0)
  })

  it("propagates storage failure instead of falling back to raw content", async () => {
    storageFailure = new Error("store failed")
    await expect(
      buildUserMessageParts({
        partsInput: [dataTextPart("B".repeat(2048))],
        info: userMessage(),
        sessionID: "ses_userpartstest0000000000",
        agentName: "build",
        agentPermission: {} as any,
      }),
    ).rejects.toThrow("store failed")
    expect(storedBlobs.length).toBe(0)
  })
})
