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
    pointToFile(["session_cache_ttl_sec=not_a_number", "session_cache_max_entries=123"].join("\n"))
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
    pointToFile(["some_unknown_key=42", "ratelimit_burst=7"].join("\n"))
    const eff = await Tweaks.loadEffective()
    expect(eff.rateLimit.burst).toBe(7)
  })

  test("malformed lines are ignored without corrupting parsing", async () => {
    pointToFile(["this line has no equals", "=value_without_key", "ratelimit_burst=9"].join("\n"))
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

  test("tool call budget parses status caps", async () => {
    pointToFile(
      [
        "tool_call_budget_enabled=true",
        "tool_call_budget_green_max=4",
        "tool_call_budget_yellow_max=3",
        "tool_call_budget_orange_max=2",
        "tool_call_budget_red_max=1",
        "tool_call_budget_unknown_max=1",
        "tool_call_budget_absolute_max=3",
      ].join("\n"),
    )
    const budget = await Tweaks.toolCallBudget()
    expect(budget).toEqual({
      enabled: true,
      greenMax: 4,
      yellowMax: 3,
      orangeMax: 2,
      redMax: 1,
      unknownMax: 1,
      absoluteMax: 3,
    })
  })

  test("big content boundary parses user attachment thresholds", async () => {
    pointToFile(
      [
        "boundary_user_attachment_max_bytes=4096",
        "boundary_attachment_preview_bytes=128",
        "boundary_subagent_result_max_bytes=8192",
      ].join("\n"),
    )
    const boundary = await Tweaks.bigContentBoundary()
    expect(boundary.userAttachmentMaxBytes).toBe(4096)
    expect(boundary.attachmentPreviewBytes).toBe(128)
    expect(boundary.subagentResultMaxBytes).toBe(8192)
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

  // session-ui-freshness Phase 2 task 2.6
  test("session-ui-freshness defaults when tweaks.cfg missing", async () => {
    pointToMissing()
    const ui = await Tweaks.sessionUiFreshness()
    expect(ui).toEqual({ flag: 0, softThresholdSec: 15, hardTimeoutSec: 60 })
  })

  test("session-ui-freshness parses flag=1 and custom thresholds", async () => {
    pointToFile(
      ["ui_session_freshness_enabled=1", "ui_freshness_threshold_sec=30", "ui_freshness_hard_timeout_sec=120"].join(
        "\n",
      ) + "\n",
    )
    const ui = await Tweaks.sessionUiFreshness()
    expect(ui).toEqual({ flag: 1, softThresholdSec: 30, hardTimeoutSec: 120 })
  })

  test("session-ui-freshness invalid flag falls back to default 0 (not silent)", async () => {
    pointToFile("ui_session_freshness_enabled=maybe\n")
    const ui = await Tweaks.sessionUiFreshness()
    expect(ui.flag).toBe(0)
  })

  test("session-ui-freshness soft threshold out of range falls back to default", async () => {
    pointToFile("ui_freshness_threshold_sec=0\n") // min is 1
    const ui = await Tweaks.sessionUiFreshness()
    expect(ui.softThresholdSec).toBe(15)
  })

  test("session-ui-freshness hard threshold out of range falls back to default", async () => {
    pointToFile("ui_freshness_hard_timeout_sec=999999\n") // max is 86400
    const ui = await Tweaks.sessionUiFreshness()
    expect(ui.hardTimeoutSec).toBe(60)
  })

  test("session-ui-freshness soft >= hard triggers clamp (soft = hard - 1)", async () => {
    pointToFile(["ui_freshness_threshold_sec=90", "ui_freshness_hard_timeout_sec=60"].join("\n") + "\n")
    const ui = await Tweaks.sessionUiFreshness()
    expect(ui.hardTimeoutSec).toBe(60)
    expect(ui.softThresholdSec).toBe(59)
  })

  test("session-ui-freshness soft == hard also triggers clamp", async () => {
    pointToFile(["ui_freshness_threshold_sec=60", "ui_freshness_hard_timeout_sec=60"].join("\n") + "\n")
    const ui = await Tweaks.sessionUiFreshness()
    expect(ui.softThresholdSec).toBe(59)
  })

  test("session-ui-freshness keys coexist with frontend_lazyload keys", async () => {
    pointToFile(
      ["frontend_session_lazyload=1", "ui_session_freshness_enabled=1", "ui_freshness_threshold_sec=10"].join("\n") +
        "\n",
    )
    const fl = await Tweaks.frontendLazyload()
    const ui = await Tweaks.sessionUiFreshness()
    expect(fl.flag).toBe(1)
    expect(ui.flag).toBe(1)
    expect(ui.softThresholdSec).toBe(10)
    expect(ui.hardTimeoutSec).toBe(60) // default for the untouched key
  })

  // autonomous-opt-in Phase 4.5 — autorun phrase parsing
  test("autorun defaults when tweaks.cfg missing", async () => {
    pointToMissing()
    const a = await Tweaks.autorun()
    expect(a.triggerPhrases).toContain("autorun")
    expect(a.triggerPhrases).toContain("接著跑")
    expect(a.disarmPhrases).toContain("stop")
    expect(a.disarmPhrases).toContain("停")
  })

  test("autorun parses pipe-separated trigger + disarm phrases", async () => {
    pointToFile(["autorun_trigger_phrases=go|resume|繼續", "autorun_disarm_phrases=halt|暫停"].join("\n") + "\n")
    const a = await Tweaks.autorun()
    expect(a.triggerPhrases).toEqual(["go", "resume", "繼續"])
    expect(a.disarmPhrases).toEqual(["halt", "暫停"])
  })

  test("autorun trims whitespace per phrase and drops empty slots", async () => {
    pointToFile("autorun_trigger_phrases= go |  | resume \n")
    const a = await Tweaks.autorun()
    expect(a.triggerPhrases).toEqual(["go", "resume"])
  })

  test("autorun empty value yields empty array (explicit disable)", async () => {
    pointToFile("autorun_trigger_phrases=\n")
    const a = await Tweaks.autorun()
    expect(a.triggerPhrases).toEqual([])
    // disarm untouched → defaults still present
    expect(a.disarmPhrases.length).toBeGreaterThan(0)
  })

  test("autorunSync returns defaults before loadEffective, real values after", async () => {
    pointToFile("autorun_trigger_phrases=onlyme\n")
    const beforeLoad = Tweaks.autorunSync()
    expect(beforeLoad.triggerPhrases).toContain("autorun") // defaults
    await Tweaks.loadEffective()
    const afterLoad = Tweaks.autorunSync()
    expect(afterLoad.triggerPhrases).toEqual(["onlyme"])
  })

  test("compaction budget status thresholds default and parse custom ratios", async () => {
    pointToMissing()
    expect((await Tweaks.compaction()).budgetStatusThresholds).toEqual([0.5, 0.75, 0.9])

    Tweaks.resetForTesting()
    pointToFile("compaction_budget_status_thresholds=0.4,0.7,0.95\n")
    expect((await Tweaks.compaction()).budgetStatusThresholds).toEqual([0.4, 0.7, 0.95])
  })

  test("compaction budget status thresholds reject malformed ratio lists", async () => {
    pointToFile("compaction_budget_status_thresholds=0.7,0.5,0.9\n")
    expect((await Tweaks.compaction()).budgetStatusThresholds).toEqual([0.5, 0.75, 0.9])

    Tweaks.resetForTesting()
    pointToFile("compaction_budget_status_thresholds=0.4,1.2,0.95\n")
    expect((await Tweaks.compaction()).budgetStatusThresholds).toEqual([0.5, 0.75, 0.9])
  })
})
