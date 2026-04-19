import { describe, expect, it } from "bun:test"
import { Question } from "./index"

describe("Question.normalize (top-level)", () => {
  it("returns null / undefined / primitives unchanged", () => {
    expect(Question.normalize(null)).toBe(null)
    expect(Question.normalize(undefined)).toBe(undefined)
    expect(Question.normalize(42)).toBe(42)
    expect(Question.normalize("hi")).toBe("hi")
  })

  it("returns empty object / array as-is (no recognizable shape)", () => {
    expect(Question.normalize({})).toEqual({})
    const arr: unknown[] = []
    // top-level array is not a recognized shape; returned as-is
    expect(Question.normalize(arr)).toBe(arr)
  })

  it("wraps flat single-question input into {questions:[...]}", () => {
    const input = {
      question: "What?",
      options: ["A", "B", "C"],
      multiple: false,
    }
    const out = Question.normalize(input) as any
    expect(Array.isArray(out.questions)).toBe(true)
    expect(out.questions).toHaveLength(1)
    expect(out.questions[0].question).toBe("What?")
    expect(out.questions[0].header).toBe("What?")
    expect(out.questions[0].options).toEqual([
      { label: "A", description: "A" },
      { label: "B", description: "B" },
      { label: "C", description: "C" },
    ])
    expect(out.questions[0].multiple).toBe(false)
  })

  it("normalizes each question when questions is already an array", () => {
    const input = {
      questions: [
        { question: "Q1?", options: ["X", "Y"], multiple: false },
        { question: "Q2?", options: ["Z"], multiple: true },
      ],
    }
    const out = Question.normalize(input) as any
    expect(out.questions).toHaveLength(2)
    expect(out.questions[0].header).toBe("Q1?")
    expect(out.questions[0].options[0]).toEqual({ label: "X", description: "X" })
    expect(out.questions[1].header).toBe("Q2?")
    expect(out.questions[1].multiple).toBe(true)
  })

  it("leaves canonical input structurally equal", () => {
    const input = {
      questions: [
        {
          question: "Q?",
          header: "Q",
          options: [{ label: "A", description: "desc-A" }],
          multiple: false,
        },
      ],
    }
    const out = Question.normalize(input) as any
    expect(out.questions).toHaveLength(1)
    expect(out.questions[0].question).toBe("Q?")
    expect(out.questions[0].header).toBe("Q")
    expect(out.questions[0].options).toEqual([{ label: "A", description: "desc-A" }])
  })

  it("does not overwrite header when caller provided one", () => {
    const input = {
      question: "Very long question text that would exceed 30 chars",
      header: "Short",
      options: ["A"],
    }
    const out = Question.normalize(input) as any
    expect(out.questions[0].header).toBe("Short")
  })

  it("truncates auto-generated header to 30 chars", () => {
    const q = "a".repeat(80)
    const input = { question: q, options: ["A"] }
    const out = Question.normalize(input) as any
    expect(out.questions[0].header).toBe("a".repeat(30))
  })

  it("preserves multiple=true and custom fields on the question", () => {
    const input = {
      questions: [
        { question: "Q?", options: ["A", "B"], multiple: true, custom: false },
      ],
    }
    const out = Question.normalize(input) as any
    expect(out.questions[0].multiple).toBe(true)
    expect(out.questions[0].custom).toBe(false)
  })

  it("coerces option with value/detail keys to label/description", () => {
    const input = {
      question: "Q?",
      options: [{ value: "A", detail: "The first choice" }],
    }
    const out = Question.normalize(input) as any
    const opt = out.questions[0].options[0]
    expect(opt.label).toBe("A")
    expect(opt.description).toBe("The first choice")
    // original fields retained
    expect(opt.value).toBe("A")
    expect(opt.detail).toBe("The first choice")
  })

  it("coerces option with label/explanation keys", () => {
    const input = {
      question: "Q?",
      options: [{ label: "A", explanation: "Reasoning" }],
    }
    const out = Question.normalize(input) as any
    const opt = out.questions[0].options[0]
    expect(opt.label).toBe("A")
    expect(opt.description).toBe("Reasoning")
  })

  it("falls back description to label when neither description/detail/explanation present", () => {
    const input = {
      question: "Q?",
      options: [{ label: "A" }],
    }
    const out = Question.normalize(input) as any
    const opt = out.questions[0].options[0]
    expect(opt.label).toBe("A")
    expect(opt.description).toBe("A")
  })
})

describe("Question.normalizeSingle", () => {
  it("returns null / primitives unchanged", () => {
    expect(Question.normalizeSingle(null)).toBe(null)
    expect(Question.normalizeSingle(7)).toBe(7)
  })

  it("fills missing header from question.slice(0,30)", () => {
    const out = Question.normalizeSingle({
      question: "short",
      options: [{ label: "A", description: "B" }],
    }) as any
    expect(out.header).toBe("short")
  })

  it("does not throw on malformed options (leaves unrecognizable entries as-is)", () => {
    const out = Question.normalizeSingle({
      question: "Q?",
      options: [{ foo: "unknown" }, "A"],
    }) as any
    // first option had no label/value → left as-is (no recognized shape)
    expect(out.options[0]).toEqual({ foo: "unknown" })
    // second option was string → coerced
    expect(out.options[1]).toEqual({ label: "A", description: "A" })
  })
})
