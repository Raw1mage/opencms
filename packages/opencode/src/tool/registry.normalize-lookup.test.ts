import { describe, expect, it } from "bun:test"
import { ToolRegistry } from "./registry"

/**
 * Integration-adjacent test for DD-3: proves processor.ts can use
 * ToolRegistry.getParameters(toolName).safeParse(rawInput) to convert
 * a raw LLM tool-call shape into the normalized canonical shape that
 * session state.input will persist.
 *
 * We test the lookup + safeParse path without booting a session/
 * streaming processor — just the building block processor relies on.
 */
describe("ToolRegistry.getParameters + safeParse (DD-3 building block)", () => {
  it("returns undefined for unknown tool id (miss path)", async () => {
    const schema = await ToolRegistry.getParameters("this_tool_does_not_exist_xyz")
    expect(schema).toBeUndefined()
  })

  it("normalizes question tool flat input via safeParse → canonical shape", async () => {
    const schema = await ToolRegistry.getParameters("question")
    expect(schema).toBeDefined()

    const rawFlat = {
      question: "Pick one?",
      options: ["A", "B", "C"],
      multiple: false,
    }
    const parsed = schema!.safeParse(rawFlat)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const data = parsed.data as any
      expect(data.questions).toHaveLength(1)
      expect(data.questions[0].question).toBe("Pick one?")
      expect(data.questions[0].header).toBe("Pick one?")
      expect(data.questions[0].options).toEqual([
        { label: "A", description: "A" },
        { label: "B", description: "B" },
        { label: "C", description: "C" },
      ])
    }
  })

  it("normalizes question tool array-with-string-options via safeParse", async () => {
    const schema = await ToolRegistry.getParameters("question")
    const raw = {
      questions: [{ question: "X?", options: ["A", "B"], multiple: false }],
    }
    const parsed = schema!.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const data = parsed.data as any
      expect(data.questions[0].header).toBe("X?")
      expect(data.questions[0].options[0]).toEqual({ label: "A", description: "A" })
    }
  })

  it("canonical question input safeParse yields structurally equal canonical shape", async () => {
    const schema = await ToolRegistry.getParameters("question")
    const canonical = {
      questions: [
        {
          question: "Q?",
          header: "Q",
          options: [{ label: "A", description: "desc" }],
          multiple: false,
        },
      ],
    }
    const parsed = schema!.safeParse(canonical)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const data = parsed.data as any
      expect(data.questions[0].question).toBe("Q?")
      expect(data.questions[0].header).toBe("Q")
      expect(data.questions[0].options).toEqual([{ label: "A", description: "desc" }])
    }
  })

  it("un-normalizable question input safeParse fails (processor falls back to raw)", async () => {
    const schema = await ToolRegistry.getParameters("question")
    const garbage = { baz: 1 }
    const parsed = schema!.safeParse(garbage)
    expect(parsed.success).toBe(false)
    // processor.ts behavior on failure: log.debug + keep raw
  })

  it("caches parameters schema across calls (same reference)", async () => {
    const first = await ToolRegistry.getParameters("question")
    const second = await ToolRegistry.getParameters("question")
    expect(first).toBe(second)
  })
})
