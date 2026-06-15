import { mkdtemp, mkdir, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { listSystemManagerTools } from "./index"
import { validateForkResult, validateForkSource } from "./system-manager-session"

describe("system-manager session tool surface", () => {
  test("exposes direct rename_session with optional session target", async () => {
    const listed = await listSystemManagerTools()
    const rename = listed.tools.find((tool) => tool.name === "rename_session")

    expect(rename).toBeDefined()
    expect(rename?.inputSchema.required).toEqual(["title"])
    expect(rename?.description).toContain("current serving session")
  })
})

describe("system-manager session fork guards", () => {
  let tmpRoot = ""
  let storageBase = ""

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "oc-smgr-"))
    storageBase = path.join(tmpRoot, "storage")
    await mkdir(path.join(storageBase, "session"), { recursive: true })
    await mkdir(path.join(storageBase, "message"), { recursive: true })
    await mkdir(path.join(storageBase, "index", "session"), { recursive: true })
  })

  afterEach(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true })
  })

  test("rejects fork source without any message history", async () => {
    await mkdir(path.join(storageBase, "session", "ses_empty"), { recursive: true })

    const result = await validateForkSource(storageBase, "ses_empty")
    expect(result.fatal.length).toBeGreaterThan(0)
  })

  test("warns when source only has user message (seed-like session)", async () => {
    const messageDir = path.join(storageBase, "session", "ses_seed", "messages", "msg_1")
    await mkdir(path.join(messageDir, "parts"), { recursive: true })
    await writeFile(path.join(messageDir, "info.json"), JSON.stringify({ id: "msg_1", role: "user" }, null, 2))

    const result = await validateForkSource(storageBase, "ses_seed")
    expect(result.fatal).toHaveLength(0)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  test("validates fork result must include index and message history", async () => {
    const result = await validateForkResult(storageBase, "ses_new")
    expect(result.fatal.length).toBeGreaterThan(0)
  })

  test("passes when fork result has index and assistant message", async () => {
    await writeFile(
      path.join(storageBase, "index", "session", "ses_ok.json"),
      JSON.stringify({ projectID: "proj" }, null, 2),
    )

    const messageDir = path.join(storageBase, "session", "ses_ok", "messages", "msg_1")
    await mkdir(path.join(messageDir, "parts"), { recursive: true })
    await writeFile(path.join(messageDir, "info.json"), JSON.stringify({ id: "msg_1", role: "assistant" }, null, 2))

    const result = await validateForkResult(storageBase, "ses_ok")
    expect(result.fatal).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  test("accepts nested session storage as canonical transcript source", async () => {
    const sessionDir = path.join(storageBase, "session", "ses_nested")
    const messageDir = path.join(sessionDir, "messages", "msg_1")
    await mkdir(path.join(messageDir, "parts"), { recursive: true })
    await writeFile(path.join(sessionDir, "info.json"), JSON.stringify({ id: "ses_nested", title: "Nested" }, null, 2))
    await writeFile(path.join(messageDir, "info.json"), JSON.stringify({ id: "msg_1", role: "user" }, null, 2))

    const result = await validateForkSource(storageBase, "ses_nested")
    expect(result.fatal).toHaveLength(0)
  })
})
