import { describe, it, expect, beforeEach } from "bun:test"
import { Tool } from "./tool"

// issues/bug_20260619_dispatcher_dedup_short_circuits_forced_rebuild.md
// issues/bug_20260619_dispatcher_dedup_eats_side_effecting_toolcall.md
// plans/dispatcher_kill-silent-dedup-cache (whitelist reframe, 2026-06-19)
//
// WHITELIST MODEL: isDedupEligible defaults to RE-RUN (false). Only an
// explicitly proven-load-bearing tool dedups. The sole whitelist member is
// apply_patch (30-day production scan: 90 dedup hits, mostly the model
// re-sending an already-succeeded patch). Everything else — native
// read/grep/bash, edit/write, and ALL MCP tools regardless of
// readOnly/idempotent/destructive hints — re-runs.
describe("Tool.isDedupEligible (whitelist model)", () => {
  beforeEach(() => {
    Tool._clearDedupHintsForTest()
  })

  it("apply_patch is the sole dedup-eligible tool (retry-protection)", () => {
    expect(Tool.isDedupEligible("apply_patch")).toBe(true)
  })

  it("native read/exploration + unregistered tools are NOT eligible (re-run; reads cost same tokens cached or fresh)", () => {
    expect(Tool.isDedupEligible("read")).toBe(false)
    expect(Tool.isDedupEligible("grep")).toBe(false)
    expect(Tool.isDedupEligible("bash")).toBe(false)
    expect(Tool.isDedupEligible("some_unknown_tool")).toBe(false)
  })

  it("native modify tools (other than apply_patch) are NOT eligible (mutation must re-run)", () => {
    expect(Tool.isDedupEligible("edit")).toBe(false)
    expect(Tool.isDedupEligible("write")).toBe(false)
    expect(Tool.isDedupEligible("multiedit")).toBe(false)
  })

  it("MCP readOnlyHint=true is NOT eligible (whitelist ignores hints)", () => {
    Tool.registerDedupHints("docxmcp_pptx_read", { readOnlyHint: true })
    expect(Tool.isDedupEligible("docxmcp_pptx_read")).toBe(false)
  })

  it("MCP idempotentHint=true is NOT eligible — fixes silent bootstrap(overwrite=true) short-circuit", () => {
    // The exact bug: docxmcp_pptx_bootstrap declares idempotentHint:true, which
    // the old blacklist treated as dedup-safe. A repeated overwrite=true call was
    // silently short-circuited and the slide never reset. Whitelist re-runs it.
    Tool.registerDedupHints("docxmcp_pptx_bootstrap", { idempotentHint: true })
    expect(Tool.isDedupEligible("docxmcp_pptx_bootstrap")).toBe(false)

    Tool.registerDedupHints("some_mcp_idempotent", { idempotentHint: true })
    expect(Tool.isDedupEligible("some_mcp_idempotent")).toBe(false)
  })

  it("MCP destructiveHint=true is NOT eligible", () => {
    Tool.registerDedupHints("docxmcp_pptx_bootstrap", { destructiveHint: true })
    expect(Tool.isDedupEligible("docxmcp_pptx_bootstrap")).toBe(false)
  })

  it("MCP with no usable hint (empty) is NOT eligible", () => {
    Tool.registerDedupHints("mcp_no_hints", {})
    expect(Tool.isDedupEligible("mcp_no_hints")).toBe(false)
  })

  it("registering MCP hints never makes a tool eligible, and never disturbs apply_patch", () => {
    Tool.registerDedupHints("docxmcp_pptx_read", { readOnlyHint: true })
    Tool.registerDedupHints("docxmcp_pptx_bootstrap", { idempotentHint: true })
    expect(Tool.isDedupEligible("docxmcp_pptx_read")).toBe(false)
    expect(Tool.isDedupEligible("docxmcp_pptx_bootstrap")).toBe(false)
    expect(Tool.isDedupEligible("apply_patch")).toBe(true)
  })
})
