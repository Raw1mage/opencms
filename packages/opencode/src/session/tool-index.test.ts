import { describe, expect, it } from "bun:test"
import {
  applyBudget,
  buildPromptInstruction,
  extractFromJournal,
  merge,
  parseFromBody,
  renderSection,
  validate,
} from "./tool-index"

function tp(callID: string, output: string, tool = "read", input: any = { path: "/foo" }) {
  return {
    type: "tool",
    callID,
    tool,
    state: {
      status: "completed",
      input,
      output,
      title: callID,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  }
}

describe("ToolIndex.extractFromJournal", () => {
  it("extracts one entry per ToolPart across messages", () => {
    const journal = [
      { roundIndex: 1, messages: [{ parts: [tp("call_a", "AAA"), { type: "text", text: "x" }] }] },
      { roundIndex: 2, messages: [{ parts: [tp("call_b", "BBB", "grep", { pattern: "x" })] }] },
    ]
    const entries = extractFromJournal(journal)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ tool_call_id: "call_a", tool_name: "read", status: "ok", output_chars: 3 })
    expect(entries[1]).toMatchObject({ tool_call_id: "call_b", tool_name: "grep", status: "ok", output_chars: 3 })
  })

  it("truncates args_brief to 80 chars", () => {
    const longInput = { huge: "x".repeat(200) }
    const journal = [{ messages: [{ parts: [tp("call_x", "Y", "read", longInput)] }] }]
    const entries = extractFromJournal(journal)
    expect(entries[0].args_brief.length).toBeLessThanOrEqual(80)
  })

  it("captures error-state output length via state.error", () => {
    const part = {
      type: "tool",
      callID: "call_err",
      tool: "bash",
      state: { status: "error", error: "ENOENT", input: { cmd: "ls" }, time: { start: 0, end: 1 } },
    }
    const entries = extractFromJournal([{ messages: [{ parts: [part] }] }])
    expect(entries[0]).toMatchObject({
      tool_call_id: "call_err",
      tool_name: "bash",
      status: "error",
      output_chars: 6,
    })
  })

  it("skips non-tool parts", () => {
    const journal = [{ messages: [{ parts: [{ type: "text", text: "hi" }, { type: "reasoning", text: "" }] }] }]
    expect(extractFromJournal(journal)).toHaveLength(0)
  })

  it("returns empty array for empty / missing input", () => {
    expect(extractFromJournal([])).toHaveLength(0)
    expect(extractFromJournal(undefined as any)).toHaveLength(0)
  })
})

describe("ToolIndex.renderSection / parseFromBody round-trip", () => {
  it("renders a well-formed section that parseFromBody can read back", () => {
    const entries = [
      { tool_call_id: "call_a", tool_name: "read", args_brief: "/foo", status: "ok" as const, output_chars: 1234 },
      { tool_call_id: "call_b", tool_name: "grep", args_brief: "pat", status: "error" as const, output_chars: 0 },
    ]
    const body = "narrative prose\n\n" + renderSection(entries)
    const parsed = parseFromBody(body)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ tool_call_id: "call_a", output_chars: 1234, status: "ok" })
    expect(parsed[1]).toMatchObject({ tool_call_id: "call_b", status: "error" })
  })

  it("emits a placeholder row when entries are empty", () => {
    const body = renderSection([])
    expect(body).toContain("(no tool calls in this period)")
  })

  it("escapes pipe characters in args_brief", () => {
    const entries = [
      { tool_call_id: "c1", tool_name: "bash", args_brief: "ls | grep x", status: "ok" as const, output_chars: 1 },
    ]
    const body = renderSection(entries)
    expect(body).toContain("ls \\| grep x")
  })
})

describe("ToolIndex.parseFromBody tolerance", () => {
  it("returns empty array when no marker", () => {
    expect(parseFromBody("just narrative")).toHaveLength(0)
  })

  it("tolerates whitespace around marker", () => {
    const body = "narrative\n\n##  TOOL_INDEX  \n\n| tool_call_id | tool_name | args_brief | status | output_chars |\n|---|---|---|---|---|\n| call_a | read | /foo | ok | 1 |"
    const entries = parseFromBody(body)
    expect(entries).toHaveLength(1)
    expect(entries[0].tool_call_id).toBe("call_a")
  })

  it("skips header and separator rows", () => {
    const body = "## TOOL_INDEX\n| tool_call_id | tool_name | args_brief | status | output_chars |\n|---|---|---|---|---|\n| call_a | read | /foo | ok | 1 |"
    const entries = parseFromBody(body)
    expect(entries).toHaveLength(1)
  })
})

describe("ToolIndex.merge", () => {
  it("appends fresh after prior, preserving order", () => {
    const prior = [
      { tool_call_id: "call_p", tool_name: "read", args_brief: "", status: "ok" as const, output_chars: 1 },
    ]
    const fresh = [
      { tool_call_id: "call_f", tool_name: "grep", args_brief: "", status: "ok" as const, output_chars: 2 },
    ]
    const merged = merge(prior, fresh)
    expect(merged.map((e) => e.tool_call_id)).toEqual(["call_p", "call_f"])
  })

  it("dedupes by tool_call_id — fresh wins", () => {
    const prior = [
      { tool_call_id: "call_dup", tool_name: "read", args_brief: "old", status: "ok" as const, output_chars: 1 },
    ]
    const fresh = [
      { tool_call_id: "call_dup", tool_name: "read", args_brief: "new", status: "ok" as const, output_chars: 99 },
    ]
    const merged = merge(prior, fresh)
    expect(merged).toHaveLength(1)
    expect(merged[0].args_brief).toBe("new")
    expect(merged[0].output_chars).toBe(99)
  })
})

describe("ToolIndex.applyBudget", () => {
  it("returns input unchanged when under budget", () => {
    const entries = [
      { tool_call_id: "c1", tool_name: "read", args_brief: "", status: "ok" as const, output_chars: 1 },
    ]
    const { entries: out, truncatedCount } = applyBudget(entries, 10_000)
    expect(out).toHaveLength(1)
    expect(truncatedCount).toBe(0)
  })

  it("truncates oldest and prepends placeholder when over budget", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      tool_call_id: `call_${i}`,
      tool_name: "read",
      args_brief: "x".repeat(60),
      status: "ok" as const,
      output_chars: 100,
    }))
    const { entries: out, truncatedCount } = applyBudget(many, 1500)
    expect(truncatedCount).toBeGreaterThan(0)
    expect(out[0].tool_call_id).toContain("truncated")
    expect(out.length).toBeLessThan(many.length)
  })
})

describe("ToolIndex.validate", () => {
  it("detects well-formed index", () => {
    const body = "narrative\n\n" + renderSection([
      { tool_call_id: "c1", tool_name: "read", args_brief: "", status: "ok" as const, output_chars: 1 },
    ])
    const r = validate(body)
    expect(r.found).toBe(true)
    expect(r.entryCount).toBe(1)
    expect(r.indexBytes).toBeGreaterThan(0)
  })

  it("flags missing marker", () => {
    const r = validate("just narrative")
    expect(r.found).toBe(false)
    expect(r.entryCount).toBe(0)
  })

  it("flags marker present but empty table", () => {
    const r = validate(renderSection([]))
    expect(r.found).toBe(true)
    expect(r.entryCount).toBe(0)
  })
})

describe("ToolIndex.buildPromptInstruction", () => {
  it("wraps the section between explicit verbatim markers", () => {
    const section = renderSection([
      { tool_call_id: "c1", tool_name: "read", args_brief: "", status: "ok" as const, output_chars: 1 },
    ])
    const instr = buildPromptInstruction(section)
    expect(instr).toContain("BEGIN_TOOL_INDEX_VERBATIM")
    expect(instr).toContain("END_TOOL_INDEX_VERBATIM")
    expect(instr).toContain("## TOOL_INDEX")
    expect(instr).toContain("verbatim")
  })
})
