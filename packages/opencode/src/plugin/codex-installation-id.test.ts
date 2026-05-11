import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import * as mod from "./codex-installation-id"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

let workDir: string
let file: string

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-install-test-"))
  file = path.join(workDir, "codex-installation-id")
  mod._resetForTesting({ path: file })
})

afterEach(async () => {
  mod._resetForTesting()
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
})

function filePath() {
  return file
}

async function loadFresh() {
  return mod
}

describe("resolveCodexInstallationId", () => {
  it("TV1: generates valid v4 UUID and persists with mode 0644 when file missing", async () => {
    const mod = await loadFresh()
    const uuid = await mod.resolveCodexInstallationId()
    expect(uuid).toMatch(UUID_RE)
    const disk = (await fs.readFile(filePath(), "utf8")).trim()
    expect(disk).toBe(uuid)
    const stat = await fs.stat(filePath())
    expect(stat.mode & 0o777).toBe(0o644)
  })

  it("TV2: idempotent — same UUID across two resolver calls in same process (memoised)", async () => {
    const mod = await loadFresh()
    const a = await mod.resolveCodexInstallationId()
    const b = await mod.resolveCodexInstallationId()
    expect(a).toBe(b)
  })

  it("TV2b: idempotent across fresh module loads when file pre-exists", async () => {
    const seed = "d2c4f6e8-1a3b-4c5d-8e9f-0a1b2c3d4e5f"
    await fs.writeFile(filePath(), seed, { mode: 0o644 })
    const mod = await loadFresh()
    const got = await mod.resolveCodexInstallationId()
    expect(got).toBe(seed)
    const disk = (await fs.readFile(filePath(), "utf8")).trim()
    expect(disk).toBe(seed)
  })

  it("TV3: rewrites file when contents are not a UUID", async () => {
    await fs.writeFile(filePath(), "not-a-uuid\n", { mode: 0o644 })
    const mod = await loadFresh()
    const uuid = await mod.resolveCodexInstallationId()
    expect(uuid).toMatch(UUID_RE)
    const disk = (await fs.readFile(filePath(), "utf8")).trim()
    expect(disk).toBe(uuid)
  })

  it("TV4: treats empty file as missing and generates", async () => {
    await fs.writeFile(filePath(), "", { mode: 0o644 })
    const mod = await loadFresh()
    const uuid = await mod.resolveCodexInstallationId()
    expect(uuid).toMatch(UUID_RE)
    const disk = (await fs.readFile(filePath(), "utf8")).trim()
    expect(disk).toBe(uuid)
  })

  it("TV5: fails loud with CodexInstallationIdResolveError when parent is read-only", async () => {
    if (process.getuid && process.getuid() === 0) return
    await fs.chmod(workDir, 0o555)
    try {
      let threw: unknown
      try {
        await mod.resolveCodexInstallationId()
      } catch (e) {
        threw = e
      }
      expect(threw).toBeDefined()
      expect((threw as Error).name).toBe("CodexInstallationIdResolveError")
    } finally {
      await fs.chmod(workDir, 0o755).catch(() => {})
    }
  })

  it("TV6: concurrent resolver calls converge on one UUID (intra-process memoisation)", async () => {
    const mod = await loadFresh()
    const results = await Promise.all([
      mod.resolveCodexInstallationId(),
      mod.resolveCodexInstallationId(),
      mod.resolveCodexInstallationId(),
    ])
    expect(results[0]).toMatch(UUID_RE)
    expect(results[1]).toBe(results[0])
    expect(results[2]).toBe(results[0])
  })
})
