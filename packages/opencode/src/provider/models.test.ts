import { describe, expect, it } from "bun:test"
import { ModelsDev } from "./models"

describe("ModelsDev.Model schema", () => {
  it("accepts optional reasoning pricing fields", () => {
    const parsed = ModelsDev.Model.parse({
      id: "test-model",
      name: "Test Model",
      release_date: "2026-01-01",
      attachment: false,
      reasoning: true,
      temperature: true,
      tool_call: true,
      limit: { context: 200000, output: 8192 },
      options: {},
      cost: {
        input: 1,
        output: 2,
        reasoning: 3,
        context_over_200k: {
          input: 4,
          output: 5,
          reasoning: 6,
        },
      },
    })

    expect(parsed.cost?.reasoning).toBe(3)
    expect(parsed.cost?.context_over_200k?.reasoning).toBe(6)
  })
})
