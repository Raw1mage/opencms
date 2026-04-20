import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Tweaks } from "../../src/config/tweaks"

const ENV_KEY = "OPENCODE_TWEAKS_PATH"

let tmpDir: string
let prevEnv: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tweaks-test-"))
  prevEnv = process.env[ENV_KEY]
  Tweaks.resetForTesting()
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = prevEnv
  Tweaks.resetForTesting()
  rmSync(tmpDir, { recursive: true, force: true })
})

function pointToFile(contents: string): string {
  const p = join(tmpDir, "tweaks.cfg")
  writeFileSync(p, contents, "utf8")
  process.env[ENV_KEY] = p
  return p
}

function pointToMissing(): string {
  const p = join(tmpDir, "does-not-exist.cfg")
  process.env[ENV_KEY] = p
  return p
}

describe("Tweaks.loadEffective", () => {
  test("returns defaults when the file is missing", async () => {
    const path = pointToMissing()
    const eff = await Tweaks.loadEffective()
    expect(eff.source).toEqual({ path, present: false })
    expect(eff.sessionCache).toEqual({ enabled: true, ttlSec: 60, maxEntries: 500 })
    expect(eff.rateLimit).toEqual({ enabled: true, qpsPerUserPerPath: 10, burst: 20 })
  })

  test("reads valid values and ignores comments / blank lines", async () => {
    pointToFile(
      [
        "# header comment",
        "",
        "session_cache_enabled=0",
        "session_cache_ttl_sec=15",
        "session_cache_max_entries=250",
        "; semi comment",
        "ratelimit_enabled=true",
        "ratelimit_qps_per_user_per_path=5",
        "ratelimit_burst=12",
      ].join("\n") + "\n",
    )
    const eff = await Tweaks.loadEffective()
    expect(eff.source.present).toBe(true)
    expect(eff.sessionCache).toEqual({ enabled: false, ttlSec: 15, maxEntries: 250 })
    expect(eff.rateLimit).toEqual({ enabled: true, qpsPerUserPerPath: 5, burst: 12 })
  })

  test("invalid integer falls back to default without swallowing other keys", async () => {
    pointToFile(
      [
        "session_cache_ttl_sec=not_a_number",
        "session_cache_max_entries=123",
      ].join("\n"),
    )
    const eff = await Tweaks.loadEffective()
    expect(eff.sessionCache.ttlSec).toBe(60)
    expect(eff.sessionCache.maxEntries).toBe(123)
  })

  test("invalid boolean falls back to default", async () => {
    pointToFile("session_cache_enabled=definitelynot")
    const eff = await Tweaks.loadEffective()
    expect(eff.sessionCache.enabled).toBe(true)
  })

  test("below-minimum integer is rejected in favor of default", async () => {
    pointToFile("session_cache_max_entries=0")
    const eff = await Tweaks.loadEffective()
    expect(eff.sessionCache.maxEntries).toBe(500)
  })

  test("non-positive float for qps is rejected", async () => {
    pointToFile("ratelimit_qps_per_user_per_path=-3")
    const eff = await Tweaks.loadEffective()
    expect(eff.rateLimit.qpsPerUserPerPath).toBe(10)
  })

  test("unknown keys are ignored (known keys still apply)", async () => {
    pointToFile(
      [
        "some_unknown_key=42",
        "ratelimit_burst=7",
      ].join("\n"),
    )
    const eff = await Tweaks.loadEffective()
    expect(eff.rateLimit.burst).toBe(7)
  })

  test("malformed lines are ignored without corrupting parsing", async () => {
    pointToFile(
      [
        "this line has no equals",
        "=value_without_key",
        "ratelimit_burst=9",
      ].join("\n"),
    )
    const eff = await Tweaks.loadEffective()
    expect(eff.rateLimit.burst).toBe(9)
  })

  test("accessors return the same snapshot as loadEffective", async () => {
    pointToFile("session_cache_ttl_sec=30\nratelimit_burst=11\n")
    const sc = await Tweaks.sessionCache()
    const rl = await Tweaks.rateLimit()
    expect(sc.ttlSec).toBe(30)
    expect(rl.burst).toBe(11)
  })

  // --- frontend-session-lazyload keys ---

  test("frontend lazyload defaults when tweaks.cfg missing", async () => {
    delete process.env[ENV_KEY]
    process.env[ENV_KEY] = join(tmpDir, "nonexistent.cfg")
    const fl = await Tweaks.frontendLazyload()
    expect(fl.flag).toBe(0)
    expect(fl.partInlineCapKb).toBe(64)
    expect(fl.tailWindowKb).toBe(64)
    expect(fl.foldPreviewLines).toBe(20)
    expect(fl.initialPageSizeSmall).toBe("all")
    expect(fl.initialPageSizeMedium).toBe(100)
    expect(fl.initialPageSizeLarge).toBe(50)
    expect(fl.sessionSizeThresholdKb).toBe(512)
    expect(fl.sessionSizeThresholdParts).toBe(80)
  })

  test("frontend lazyload parses flag=1 and custom thresholds", async () => {
    pointToFile(
      [
        "frontend_session_lazyload=1",
        "part_inline_cap_kb=128",
        "tail_window_kb=32",
        "fold_preview_lines=10",
        "initial_page_size_small=25",
        "initial_page_size_medium=75",
        "initial_page_size_large=30",
        "session_size_threshold_kb=1024",
        "session_size_threshold_parts=50",
      ].join("\n"),
    )
    const fl = await Tweaks.frontendLazyload()
    expect(fl.flag).toBe(1)
    expect(fl.partInlineCapKb).toBe(128)
    expect(fl.tailWindowKb).toBe(32)
    expect(fl.foldPreviewLines).toBe(10)
    expect(fl.initialPageSizeSmall).toBe(25)
    expect(fl.initialPageSizeMedium).toBe(75)
    expect(fl.initialPageSizeLarge).toBe(30)
    expect(fl.sessionSizeThresholdKb).toBe(1024)
    expect(fl.sessionSizeThresholdParts).toBe(50)
  })

  test("invalid flag falls back to default (not silent)", async () => {
    pointToFile("frontend_session_lazyload=maybe\n")
    const fl = await Tweaks.frontendLazyload()
    expect(fl.flag).toBe(0) // default
  })

  test("INV-7: tail_window_kb > part_inline_cap_kb is clamped to cap", async () => {
    pointToFile(
      [
        "part_inline_cap_kb=64",
        "tail_window_kb=256", // exceeds cap; should be clamped to 64
      ].join("\n"),
    )
    const fl = await Tweaks.frontendLazyload()
    expect(fl.partInlineCapKb).toBe(64)
    expect(fl.tailWindowKb).toBe(64) // clamped, not the invalid 256
  })

  test("part_inline_cap_kb out of range (too small) falls back to default", async () => {
    pointToFile("part_inline_cap_kb=2\n")
    const fl = await Tweaks.frontendLazyload()
    expect(fl.partInlineCapKb).toBe(64) // default, since 2 < min(4)
  })

  test("initial_page_size_small accepts 'all' keyword", async () => {
    pointToFile("initial_page_size_small=all\n")
    const fl = await Tweaks.frontendLazyload()
    expect(fl.initialPageSizeSmall).toBe("all")
  })

  test("initial_page_size_small accepts integer", async () => {
    pointToFile("initial_page_size_small=25\n")
    const fl = await Tweaks.frontendLazyload()
    expect(fl.initialPageSizeSmall).toBe(25)
  })

  test("initial_page_size_small invalid string falls back to default", async () => {
    pointToFile("initial_page_size_small=garbage\n")
    const fl = await Tweaks.frontendLazyload()
    expect(fl.initialPageSizeSmall).toBe("all") // default
  })
})
