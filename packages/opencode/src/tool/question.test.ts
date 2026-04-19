import { describe, expect, it } from "bun:test"
import { QuestionTool } from "./question"

/**
 * These tests exercise the QuestionTool's zod preprocess pipeline in isolation,
 * verifying that the four noncompliant input shapes documented in
 * specs/question-tool-input-normalization/test-vectors.json (TV-4..TV-7)
 * all parse to canonical form.
 *
 * We only test parameters.parse (not full execute) because execute calls
 * Question.ask which awaits a user reply — not representable in unit tests
 * without heavy fixtures. Phase 3 will add integration coverage for the
 * full runtime path through processor.ts.
 */
describe("QuestionTool parameters.parse (schema preprocess)", () => {
  it("TV-4: flat single-question wraps into questions array with header + label/desc", async () => {
    const info = await QuestionTool.init()
    const raw = {
      question: "single-surface shell 的 canonical authenticated route 要用哪個？",
      options: [
        "`/assets` 作為唯一 canonical route",
        "`/inventory` 作為唯一 canonical route",
        "`/` 作為 shell route",
      ],
      multiple: false,
    }
    const parsed = info.parameters.parse(raw) as any
    expect(parsed.questions).toHaveLength(1)
    const q = parsed.questions[0]
    expect(q.question).toBe(raw.question)
    expect(q.header).toBe(raw.question.slice(0, 30))
    expect(q.header.length).toBe(30)
    expect(q.options).toEqual([
      { label: "`/assets` 作為唯一 canonical route", description: "`/assets` 作為唯一 canonical route" },
      { label: "`/inventory` 作為唯一 canonical route", description: "`/inventory` 作為唯一 canonical route" },
      { label: "`/` 作為 shell route", description: "`/` 作為 shell route" },
    ])
    expect(q.multiple).toBe(false)
  })

  it("TV-5: string options coerced to {label, description}", async () => {
    const info = await QuestionTool.init()
    const raw = {
      questions: [{ question: "X?", options: ["A", "B"], multiple: false }],
    }
    const parsed = info.parameters.parse(raw) as any
    expect(parsed.questions[0].header).toBe("X?")
    expect(parsed.questions[0].options).toEqual([
      { label: "A", description: "A" },
      { label: "B", description: "B" },
    ])
  })

  it("TV-6: already-canonical input passes through structurally equal", async () => {
    const info = await QuestionTool.init()
    const raw = {
      questions: [
        {
          question: "X?",
          header: "X",
          options: [{ label: "A", description: "desc" }],
          multiple: false,
        },
      ],
    }
    const parsed = info.parameters.parse(raw) as any
    expect(parsed.questions).toHaveLength(1)
    expect(parsed.questions[0].question).toBe("X?")
    expect(parsed.questions[0].header).toBe("X")
    expect(parsed.questions[0].options).toEqual([{ label: "A", description: "desc" }])
    expect(parsed.questions[0].multiple).toBe(false)
  })

  it("TV-7: multi-question with multiple=true and mixed shapes", async () => {
    const info = await QuestionTool.init()
    const raw = {
      questions: [
        { question: "Q1?", options: ["A", "B", "C"], multiple: true },
        { question: "Q2?", options: ["X", "Y"], multiple: false },
      ],
    }
    const parsed = info.parameters.parse(raw) as any
    expect(parsed.questions).toHaveLength(2)
    expect(parsed.questions[0].multiple).toBe(true)
    expect(parsed.questions[0].options[0]).toEqual({ label: "A", description: "A" })
    expect(parsed.questions[1].multiple).toBe(false)
    expect(parsed.questions[1].header).toBe("Q2?")
  })

  it("rejects fully malformed input (triggers formatValidationError path)", async () => {
    const info = await QuestionTool.init()
    expect(() => info.parameters.parse({ baz: 1 } as any)).toThrow()
  })
})
