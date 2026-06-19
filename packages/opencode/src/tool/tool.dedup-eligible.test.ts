import { describe, it, expect, beforeEach } from "bun:test"
import { Tool } from "./tool"

// issues/bug_20260619_dispatcher_dedup_short_circuits_forced_rebuild.md
// Verifies isDedupEligible's native-vs-MCP split: native/unregistered tools stay
// dedup-eligible (preserving apply_patch dedup); MCP tools dedup only when
// explicitly readOnly/idempotent — destructive or unannotated tools re-run.
describe("Tool.isDedupEligible", () => {
  beforeEach(() => {
    Tool._clearDedupHintsForTest()
  })

  it("native / unregistered tools are dedup-eligible", () => {
    expect(Tool.isDedupEligible("read")).toBe(true)
    expect(Tool.isDedupEligible("apply_patch")).toBe(true)
    expect(Tool.isDedupEligible("some_unknown_tool")).toBe(true)
  })

  it("MCP tool with readOnlyHint=true is eligible", () => {
    Tool.registerDedupHints("docxmcp_pptx_read", { readOnlyHint: true })
    expect(Tool.isDedupEligible("docxmcp_pptx_read")).toBe(true)
  })

  it("MCP tool with idempotentHint=true is eligible", () => {
    Tool.registerDedupHints("some_mcp_idempotent", { idempotentHint: true })
    expect(Tool.isDedupEligible("some_mcp_idempotent")).toBe(true)
  })

  it("MCP tool with destructiveHint=true (no readOnly/idempotent) is NOT eligible", () => {
    Tool.registerDedupHints("docxmcp_pptx_bootstrap", { destructiveHint: true })
    expect(Tool.isDedupEligible("docxmcp_pptx_bootstrap")).toBe(false)
  })

  it("MCP tool registered with no usable hint (empty) is NOT eligible (fail-safe)", () => {
    Tool.registerDedupHints("mcp_no_hints", {})
    expect(Tool.isDedupEligible("mcp_no_hints")).toBe(false)
  })

  it("readOnly wins even when destructiveHint is also set", () => {
    Tool.registerDedupHints("mixed_hints", { readOnlyHint: true, destructiveHint: true })
    expect(Tool.isDedupEligible("mixed_hints")).toBe(true)
  })

  it("registering an MCP tool does not affect native tool eligibility", () => {
    Tool.registerDedupHints("docxmcp_pptx_bootstrap", { destructiveHint: true })
    expect(Tool.isDedupEligible("read")).toBe(true)
    expect(Tool.isDedupEligible("apply_patch")).toBe(true)
  })

  it("latest registration wins (idempotent re-register)", () => {
    Tool.registerDedupHints("rebound", { readOnlyHint: true })
    expect(Tool.isDedupEligible("rebound")).toBe(true)
    Tool.registerDedupHints("rebound", { destructiveHint: true })
    expect(Tool.isDedupEligible("rebound")).toBe(false)
  })
})
