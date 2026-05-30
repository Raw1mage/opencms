/**
 * Tests for ANTML tool-call salvage (incident 2026-05-30 ses_189df799…).
 * The model leaked `<invoke name="mcp__bash">…</invoke>` as text; we recover it.
 */
import { describe, expect, test } from "bun:test"
import { salvageAntmlInvokes, mayContainAntmlInvoke } from "../src/antml-salvage.js"

describe("salvageAntmlInvokes", () => {
  test("recovers a single leaked bash invoke (the real incident shape)", () => {
    const text =
      "course\n" +
      '<invoke name="mcp__bash">\n' +
      '<parameter name="command">cd /home/pkcs12/projects/llmserver && cargo build</parameter>\n' +
      '<parameter name="description">Build llmserver</parameter>\n' +
      "</invoke>"
    const calls = salvageAntmlInvokes(text)
    expect(calls.length).toBe(1)
    expect(calls[0]!.name).toBe("mcp__bash")
    const input = JSON.parse(calls[0]!.input)
    expect(input.command).toBe("cd /home/pkcs12/projects/llmserver && cargo build")
    expect(input.description).toBe("Build llmserver")
  })

  test("recovers multiple invokes in one text block", () => {
    const text =
      '<invoke name="mcp__edit"><parameter name="path">a.ts</parameter></invoke>\n' +
      "some prose\n" +
      '<invoke name="mcp__bash"><parameter name="command">ls</parameter></invoke>'
    const calls = salvageAntmlInvokes(text)
    expect(calls.length).toBe(2)
    expect(calls[0]!.name).toBe("mcp__edit")
    expect(calls[1]!.name).toBe("mcp__bash")
  })

  test("accepts the namespace-prefixed variant", () => {
    // Build the `antml:`-prefixed tags via concatenation so this source file
    // does not itself contain a literal closing invoke tag.
    const ns = "antml:"
    const text =
      "<" + ns + 'invoke name="mcp__bash">' +
      "<" + ns + 'parameter name="command">pwd</' + ns + "parameter>" +
      "</" + ns + "invoke>"
    const calls = salvageAntmlInvokes(text)
    expect(calls.length).toBe(1)
    expect(calls[0]!.name).toBe("mcp__bash")
    expect(JSON.parse(calls[0]!.input).command).toBe("pwd")
  })

  test("ignores a truncated/unclosed invoke (no half tool calls)", () => {
    const text = 'Of course\n<invoke name="mcp__bash">\n<parameter name="command">ls'
    expect(salvageAntmlInvokes(text)).toEqual([])
  })

  test("normal prose yields nothing and is cheap-checked", () => {
    const text = "Just a normal answer with no tool calls at all."
    expect(mayContainAntmlInvoke(text)).toBe(false)
    expect(salvageAntmlInvokes(text)).toEqual([])
  })

  test("strips the single wrapping newline around a multi-line value", () => {
    const text =
      '<invoke name="mcp__bash"><parameter name="command">\nline1\nline2\n</parameter></invoke>'
    const input = JSON.parse(salvageAntmlInvokes(text)[0]!.input)
    expect(input.command).toBe("line1\nline2")
  })
})
