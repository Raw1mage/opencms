import { describe, expect, it } from "bun:test"
import { renderSection, stripAllSections } from "./tool-index"

describe("ToolIndex.stripAllSections", () => {
  it("returns body unchanged when no section present", () => {
    const body = "just prose narrative here"
    expect(stripAllSections(body)).toBe(body)
  })

  it("strips a trailing section, leaving prose intact", () => {
    const section = renderSection([
      { tool_call_id: "c1", tool_name: "read", args_brief: "/foo", status: "ok", output_chars: 1 },
    ])
    const body = "narrative prose paragraph\n\n" + section
    const stripped = stripAllSections(body)
    expect(stripped).toBe("narrative prose paragraph")
  })

  it("strips a middle section, preserving content on both sides", () => {
    const section = renderSection([
      { tool_call_id: "c1", tool_name: "read", args_brief: "/foo", status: "ok", output_chars: 1 },
    ])
    const body = "head prose\n\n" + section + "\ntail prose that must survive"
    const stripped = stripAllSections(body)
    expect(stripped).toContain("head prose")
    expect(stripped).toContain("tail prose that must survive")
    expect(stripped).not.toContain("## TOOL_INDEX")
  })

  it("strips multiple sections in one pass", () => {
    const s1 = renderSection([
      { tool_call_id: "a", tool_name: "read", args_brief: "", status: "ok", output_chars: 1 },
    ])
    const s2 = renderSection([
      { tool_call_id: "b", tool_name: "grep", args_brief: "", status: "ok", output_chars: 2 },
    ])
    const body = "first prose\n\n" + s1 + "\nmiddle prose\n\n" + s2 + "\nend prose"
    const stripped = stripAllSections(body)
    expect(stripped).toContain("first prose")
    expect(stripped).toContain("middle prose")
    expect(stripped).toContain("end prose")
    expect(stripped).not.toContain("## TOOL_INDEX")
  })

  it("handles section terminated by blank line then more prose", () => {
    const section = renderSection([
      { tool_call_id: "c1", tool_name: "read", args_brief: "", status: "ok", output_chars: 1 },
    ])
    const body = "head\n\n" + section.trimEnd() + "\n\nsubsequent paragraph"
    const stripped = stripAllSections(body)
    expect(stripped).toContain("head")
    expect(stripped).toContain("subsequent paragraph")
    expect(stripped).not.toContain("## TOOL_INDEX")
  })

  it("preserves new dialog appended after a prior section (the production bug case)", () => {
    // Simulate the narrative path: prevAnchor.body = "prevProse\n\n##TOOL_INDEX\n|table|"
    // then summaryText = prevAnchor.body + "\n\n" + newDialogTail.
    const section = renderSection([
      { tool_call_id: "old1", tool_name: "read", args_brief: "/old", status: "ok", output_chars: 100 },
      { tool_call_id: "old2", tool_name: "grep", args_brief: "x", status: "ok", output_chars: 50 },
    ])
    const newDialog = "Round 50 user: foo\nRound 50 assistant: bar\nRound 51 user: baz\n"
    const summaryText = "Round 1..49 prose narrative\n\n" + section + "\n\n" + newDialog
    const stripped = stripAllSections(summaryText)
    expect(stripped).toContain("Round 1..49 prose narrative")
    expect(stripped).toContain("Round 50 user: foo")
    expect(stripped).toContain("Round 51 user: baz")
    expect(stripped).not.toContain("## TOOL_INDEX")
    expect(stripped).not.toContain("old1")
    expect(stripped).not.toContain("old2")
  })

  it("safety guard: does not loop forever on malformed input", () => {
    // Build a string with many sections to verify the 100-iter cap doesn't fire
    // erroneously and the function still completes.
    const sections = Array.from({ length: 20 }, (_, i) =>
      renderSection([
        { tool_call_id: `c${i}`, tool_name: "read", args_brief: "", status: "ok", output_chars: 1 },
      ]),
    ).join("\n\nlinker\n\n")
    const stripped = stripAllSections(sections)
    expect(stripped).not.toContain("## TOOL_INDEX")
  })
})
