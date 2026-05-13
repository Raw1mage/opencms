import { describe, expect, test } from "bun:test"
import { normalizeMcpToolResult } from "../../src/session/resolve-tools"

describe("resolve-tools MCP result normalization", () => {
  test("preserves standard MCP content arrays", () => {
    const result = normalizeMcpToolResult("specbase_plan_check", {
      content: [{ type: "text", text: "ok" }],
      metadata: { ready: true },
    })

    expect(result.content).toEqual([{ type: "text", text: "ok" }])
    expect(result.metadata).toEqual({ ready: true })
  })

  test("converts native tool/dedup output into MCP text content", () => {
    const result = normalizeMcpToolResult("specbase_plan_check", {
      title: "",
      output: "ready: true",
      metadata: { dedup: { shortCircuited: true } },
    })

    expect(result.content).toEqual([{ type: "text", text: "ready: true" }])
    expect(result.metadata?.dedup).toEqual({ shortCircuited: true })
    expect(result.metadata?.mcpNormalized).toEqual({ reason: "native_tool_result_without_content" })
  })

  test("converts plain JSON results into text content", () => {
    const result = normalizeMcpToolResult("specbase_plan_check", {
      ready: true,
      state: "planned",
    })

    expect(result.content[0].type).toBe("text")
    expect(result.content[0].text).toContain('"ready": true')
    expect(result.content[0].text).toContain('"state": "planned"')
    expect(result.structuredContent).toEqual({ ready: true, state: "planned" })
    expect(result.metadata?.mcpNormalized).toEqual({ reason: "plain_result_without_content" })
  })

  test("returns a structured error for undefined MCP results", () => {
    const result = normalizeMcpToolResult("specbase_spec_sync", undefined)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("mcp_tool_invalid_result")
    expect(result.content[0].text).toContain("specbase_spec_sync")
    expect(result.metadata?.mcpNormalized).toEqual({ reason: "missing_result" })
  })
})
