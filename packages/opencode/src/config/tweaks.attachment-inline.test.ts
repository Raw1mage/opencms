import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { Tweaks } = await import("@/config/tweaks")

const ENV_KEY = "OPENCODE_TWEAKS_PATH"
let tmpDir: string
let prevEnv: string | undefined

async function loadFromCfg(body: string): Promise<void> {
  const path = join(tmpDir, "tweaks.cfg")
  writeFileSync(path, body, "utf8")
  process.env[ENV_KEY] = path
  Tweaks.resetForTesting()
  await Tweaks.loadEffective()
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tweaks-attinline-test-"))
  prevEnv = process.env[ENV_KEY]
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = prevEnv
  Tweaks.resetForTesting()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("Tweaks.attachmentInline (v4 DD-19/DD-20)", () => {
  it("uses defaults when tweaks.cfg absent", async () => {
    process.env[ENV_KEY] = join(tmpDir, "does-not-exist.cfg")
    Tweaks.resetForTesting()
    const cfg = await Tweaks.attachmentInline()
    // v5 DD-22.2: default raised 3 → 8 (cap now bounds AI-driven reread, not upload).
    expect(cfg).toEqual({ enabled: true, activeSetMax: 8 })
    expect(Tweaks.attachmentInlineSync()).toEqual({ enabled: true, activeSetMax: 8 })
  })

  it("respects attachment_inline_enabled=false", async () => {
    await loadFromCfg("attachment_inline_enabled=false\n")
    expect((await Tweaks.attachmentInline()).enabled).toBe(false)
  })

  it("respects attachment_active_set_max custom value", async () => {
    await loadFromCfg("attachment_active_set_max=5\n")
    expect((await Tweaks.attachmentInline()).activeSetMax).toBe(5)
  })

  it("falls back to default when attachment_active_set_max out of range (v5 range 1-50)", async () => {
    await loadFromCfg("attachment_active_set_max=999\n")
    expect((await Tweaks.attachmentInline()).activeSetMax).toBe(8)
  })

  it("v5 DD-22.2 accepts up to 50 (was 20)", async () => {
    await loadFromCfg("attachment_active_set_max=50\n")
    expect((await Tweaks.attachmentInline()).activeSetMax).toBe(50)
  })

  it("attachmentInlineSync mirrors attachmentInline once loaded", async () => {
    await loadFromCfg("attachment_inline_enabled=false\nattachment_active_set_max=2\n")
    const sync = Tweaks.attachmentInlineSync()
    expect(sync).toEqual({ enabled: false, activeSetMax: 2 })
  })
})
