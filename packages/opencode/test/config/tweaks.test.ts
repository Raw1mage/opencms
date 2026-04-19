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
})
