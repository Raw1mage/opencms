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
  tmpDir = mkdtempSync(join(tmpdir(), "tweaks-compaction-items-test-"))
  prevEnv = process.env[ENV_KEY]
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = prevEnv
  Tweaks.resetForTesting()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("Tweaks.compaction item overflow thresholds", () => {
  it("uses provider-specific defaults", async () => {
    process.env[ENV_KEY] = join(tmpDir, "does-not-exist.cfg")
    Tweaks.resetForTesting()
    const cfg = await Tweaks.compaction()
    expect(cfg.codexItemOverflowThreshold).toBe(350)
    expect(cfg.claudeItemOverflowThreshold).toBe(10_000)
  })

  it("loads provider-specific thresholds from tweaks.cfg", async () => {
    await loadFromCfg("compaction_codex_item_overflow_threshold=420\ncompaction_claude_item_overflow_threshold=12000\n")
    const cfg = Tweaks.compactionSync()
    expect(cfg.codexItemOverflowThreshold).toBe(420)
    expect(cfg.claudeItemOverflowThreshold).toBe(12_000)
  })

  it("falls back to defaults when thresholds are out of range", async () => {
    await loadFromCfg("compaction_codex_item_overflow_threshold=0\ncompaction_claude_item_overflow_threshold=100001\n")
    const cfg = Tweaks.compactionSync()
    expect(cfg.codexItemOverflowThreshold).toBe(350)
    expect(cfg.claudeItemOverflowThreshold).toBe(10_000)
  })
})
