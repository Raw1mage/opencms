import { describe, expect, test } from "bun:test"
import { detectEmptyShell, normalizeMcpToolResult } from "../../src/session/resolve-tools"

type McpResultLike = {
  isError?: boolean
  content?: Array<{ type: string; text?: string; resource?: { text?: string; blob?: string; uri?: string } }>
  structuredContent?: unknown
}

// Pure replica of shapeMcpResult's deterministic core (DD-1..4) so the contract
// is unit-testable offline. Mirrors resolve-tools.ts:362-443: collect visible
// text + resource text, then DD-2/DD-3 empty-shell detection → structuredContent
// backfill (skipped for isError). Truncation is omitted (covered by INV-0 path);
// these vectors only assert presentation/backfill semantics, not token budget.
function composePresentation(result: McpResultLike): {
  output: string
  presentationBackfill?: { reason: string; bytes: number }
} {
  const textParts: string[] = []
  for (const item of result.content ?? []) {
    if (item.type === "text") textParts.push(item.text ?? "")
    else if (item.type === "resource" && item.resource?.text) textParts.push(item.resource.text)
  }
  let presentationBackfill: { reason: string; bytes: number } | undefined
  const joined = textParts.join("\n\n")
  if (!result.isError && result.structuredContent !== undefined) {
    const shell = detectEmptyShell(joined)
    if (shell.isEmptyShell) {
      const serialized =
        typeof result.structuredContent === "string"
          ? result.structuredContent
          : JSON.stringify(result.structuredContent, null, 2)
      if (serialized) {
        textParts.length = 0
        textParts.push(serialized)
        presentationBackfill = { reason: shell.reason, bytes: new TextEncoder().encode(serialized).length }
      }
    }
  }
  return { output: textParts.join("\n\n"), ...(presentationBackfill && { presentationBackfill }) }
}

// Inlined from plans/mcp_tool-result-presentation-contract/test-vectors.json (TV1..TV8).
// Kept here (not imported) because /plans/ is gitignored and outside the package rootDir.
const testVectors: Array<{
  id: string
  desc: string
  input: McpResultLike
  expect: Record<string, unknown>
}> = [
  {
    id: "TV1-empty-shell-backfill",
    desc: "純 structuredContent + 佔位 text → 回填（BR 真因案例）",
    input: {
      isError: false,
      content: [{ type: "text", text: "ok=True; see structuredContent" }],
      structuredContent: { items: [{ id: "thesmart-16x9" }, { id: "thesmart-4x3" }] },
    },
    expect: {
      output_contains: ["thesmart-16x9", "thesmart-4x3"],
      output_is_empty_shell: false,
      "metadata.presentationBackfill.reason": "see_structured_placeholder",
      "metadata.presentationBackfill.bytes_gt": 0,
    },
  },
  {
    id: "TV2-empty-string-backfill",
    desc: "空字串 text + structuredContent → 回填",
    input: { isError: false, content: [{ type: "text", text: "" }], structuredContent: { state: "ready" } },
    expect: { output_contains: ["ready"], "metadata.presentationBackfill.reason": "empty" },
  },
  {
    id: "TV3-whitespace-backfill",
    desc: "純空白 text + structuredContent → 回填",
    input: { isError: false, content: [{ type: "text", text: "   \n  " }], structuredContent: { count: 3 } },
    expect: { output_contains: ["count"], "metadata.presentationBackfill.reason": "whitespace_only" },
  },
  {
    id: "TV4-normal-text-no-backfill",
    desc: "text 已含主體（也帶 structuredContent）→ 不回填",
    input: {
      isError: false,
      content: [{ type: "text", text: "Found 2 templates: thesmart-16x9, thesmart-4x3" }],
      structuredContent: { items: [] },
    },
    expect: { output_contains: ["Found 2 templates"], "metadata.presentationBackfill_absent": true },
  },
  {
    id: "TV5-pure-structured-no-text",
    desc: "完全沒有 text content item，只有 structuredContent → 回填",
    input: { isError: false, content: [], structuredContent: { data: "x" } },
    expect: { output_contains: ["x"], "metadata.presentationBackfill.reason": "empty" },
  },
  {
    id: "TV6-iserror-no-backfill",
    desc: "isError=true 帶 structuredContent error → 不回填 structuredContent（錯誤路徑既有行為）",
    input: {
      isError: true,
      content: [{ type: "text", text: "mcp_tool_invalid_result" }],
      structuredContent: { error: "boom" },
    },
    expect: { output_contains: ["mcp_tool_invalid_result"], "metadata.presentationBackfill_absent": true },
  },
  {
    id: "TV7-resource-attachment",
    desc: "resource.text 進 output、不誤判空殼",
    input: {
      isError: false,
      content: [{ type: "resource", resource: { text: "readable resource body", uri: "file://x" } }],
    },
    expect: { output_contains: ["readable resource body"], "metadata.presentationBackfill_absent": true },
  },
  {
    id: "TV8-no-structured-stays-shell",
    desc: "空殼但無 structuredContent → 無從回填，output 維持空殼（不捏造）",
    input: { isError: false, content: [{ type: "text", text: "see structuredContent" }] },
    expect: { output_contains: ["see structuredContent"], "metadata.presentationBackfill_absent": true },
  },
]

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

describe("presentation contract: empty-shell detection (DD-2)", () => {
  test("detectEmptyShell classifies each shell category", () => {
    expect(detectEmptyShell("")).toEqual({ isEmptyShell: true, reason: "empty" })
    expect(detectEmptyShell("   \n  ")).toEqual({ isEmptyShell: true, reason: "whitespace_only" })
    expect(detectEmptyShell("see structuredContent")).toEqual({
      isEmptyShell: true,
      reason: "see_structured_placeholder",
    })
    expect(detectEmptyShell("ok=True; see structuredContent")).toEqual({
      isEmptyShell: true,
      reason: "see_structured_placeholder",
    })
  })

  test("detectEmptyShell does NOT flag substantive text (DD-2 strictness)", () => {
    // real prose merely mentioning the phrase is NOT a shell (anchored regex)
    expect(detectEmptyShell("Found 2 templates: see structuredContent for the rest")).toEqual({
      isEmptyShell: false,
      reason: "not_shell",
    })
    expect(detectEmptyShell("Found 2 templates")).toEqual({ isEmptyShell: false, reason: "not_shell" })
  })
})

describe("presentation contract: composePresentation over test-vectors TV1..TV8", () => {
  for (const tv of testVectors) {
    test(`${tv.id} — ${tv.desc}`, () => {
      const { output, presentationBackfill } = composePresentation(tv.input)

      for (const needle of (tv.expect.output_contains as string[]) ?? []) {
        expect(output).toContain(needle)
      }

      const expectedReason = tv.expect["metadata.presentationBackfill.reason"] as string | undefined
      if (expectedReason) {
        expect(presentationBackfill).toBeDefined()
        expect(presentationBackfill!.reason).toBe(expectedReason)
      }
      if (tv.expect["metadata.presentationBackfill.bytes_gt"] !== undefined) {
        expect(presentationBackfill!.bytes).toBeGreaterThan(
          tv.expect["metadata.presentationBackfill.bytes_gt"] as number,
        )
      }
      if (tv.expect["metadata.presentationBackfill_absent"] === true) {
        expect(presentationBackfill).toBeUndefined()
      }
      if (tv.expect.output_is_empty_shell === false) {
        // INV-PRESENT exit assertion: backfilled output is no longer an empty shell
        expect(detectEmptyShell(output).isEmptyShell).toBe(false)
      }
    })
  }
})

describe("INV-0 baseline (DD-5): native-shaped results pass through without backfill", () => {
  // A native tool result (no structuredContent) NEVER triggers presentation
  // backfill — the contract only acts when structuredContent carries the body.
  // This guards the byte-identical native path (resolve-tools.ts: native tools
  // route via ToolInvoker.execute and never reach shapeMcpResult).
  test("native output without structuredContent is never backfilled", () => {
    const result = composePresentation({ isError: false, content: [{ type: "text", text: "ready: true" }] })
    expect(result.output).toBe("ready: true")
    expect(result.presentationBackfill).toBeUndefined()
  })

  test("empty native output with no structuredContent stays empty (no fabrication)", () => {
    const result = composePresentation({ isError: false, content: [{ type: "text", text: "" }] })
    expect(result.output).toBe("")
    expect(result.presentationBackfill).toBeUndefined()
  })
})
