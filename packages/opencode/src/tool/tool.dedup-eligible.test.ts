import { describe, it, expect, beforeEach } from "bun:test"
import { Tool } from "./tool"

// issues/bug_20260619_dispatcher_dedup_short_circuits_forced_rebuild.md
// issues/bug_20260619_dispatcher_dedup_eats_side_effecting_toolcall.md (D1, native half)
// Verifies isDedupEligible's native-vs-MCP split:
//   - native read/exploration + unregistered tools → dedup-eligible
//   - native modify-kind tools (edit/write/multiedit/...) → NOT eligible (re-run
//     the mutation rather than reuse stale result)
//   - EXCEPTION: apply_patch stays dedup-eligible (retry-protection)
//   - MCP tools dedup only when explicitly readOnly/idempotent
describe("Tool.isDedupEligible", () => {
  beforeEach(() => {
    Tool._clearDedupHintsForTest()
  })

  it("native read/exploration + unregistered tools are dedup-eligible", () => {
    expect(Tool.isDedupEligible("read")).toBe(true)
    expect(Tool.isDedupEligible("grep")).toBe(true)
    expect(Tool.isDedupEligible("bash")).toBe(true)
    expect(Tool.isDedupEligible("some_unknown_tool")).toBe(true)
  })

  it("native modify tools are NOT dedup-eligible (mutation must re-run)", () => {
    expect(Tool.isDedupEligible("edit")).toBe(false)
    expect(Tool.isDedupEligible("write")).toBe(false)
    expect(Tool.isDedupEligible("multiedit")).toBe(false)
  })

  it("apply_patch stays dedup-eligible despite being modify-kind (retry-protection)", () => {
    expect(Tool.isDedupEligible("apply_patch")).toBe(true)
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
