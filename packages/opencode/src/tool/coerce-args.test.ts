import { describe, expect, it } from "bun:test"
import type { JSONSchema7 } from "ai"
import { jsonSchema } from "ai"
import { CoerceArgs } from "./coerce-args"

// bug_20260617 + DD-21: typed tool args (object/number/array/boolean) arrive
// stringified via the Claude ANTML-salvage path and fail schema validation.
// These cover the two seam helpers used by session/llm.ts repairToolCall, on
// top of coerceArgsToSchema (covered against MCP in mcp/coerce-args.test.ts).

const schema = {
  type: "object",
  properties: {
    out_dir: { type: "string" },
    wall_thickness_mm: { type: "number" },
    layers: { type: "integer" },
    enabled: { type: "boolean" },
    targets: { type: "array" },
    constraints: { type: "object" },
  },
} satisfies JSONSchema7

describe("CoerceArgs.coerceToolCallInput", () => {
  it("re-types a stringified array arg inside a JSON-string tool input", () => {
    // The exact failing shape from the screenshot: targets="[\"daemon\"]".
    const raw = JSON.stringify({ targets: '["daemon"]' })
    const out = CoerceArgs.coerceToolCallInput(raw, schema)
    expect(JSON.parse(out as string)).toEqual({ targets: ["daemon"] })
  })

  it("re-types mixed object/number/boolean args at once", () => {
    const raw = JSON.stringify({
      constraints: '{"a":1}',
      wall_thickness_mm: "2.5",
      enabled: "true",
      layers: "4",
    })
    const out = CoerceArgs.coerceToolCallInput(raw, schema)
    expect(JSON.parse(out as string)).toEqual({
      constraints: { a: 1 },
      wall_thickness_mm: 2.5,
      enabled: true,
      layers: 4,
    })
  })

  it("returns the original bytes verbatim when nothing is coerced", () => {
    const raw = JSON.stringify({ out_dir: "incoming/foo" })
    const out = CoerceArgs.coerceToolCallInput(raw, schema)
    expect(out).toBe(raw) // same reference — no re-serialization
  })

  it("passes through non-string input unchanged", () => {
    const obj = { targets: ["daemon"] }
    expect(CoerceArgs.coerceToolCallInput(obj, schema)).toBe(obj)
  })

  it("passes through empty / unparseable / non-object roots", () => {
    expect(CoerceArgs.coerceToolCallInput("", schema)).toBe("")
    expect(CoerceArgs.coerceToolCallInput("not json", schema)).toBe("not json")
    expect(CoerceArgs.coerceToolCallInput("[1,2,3]", schema)).toBe("[1,2,3]")
  })

  it("leaves a value untouched when the parsed runtime type mismatches the schema", () => {
    // layers declares integer; "4.5" parses to a non-integer → leave as string.
    const raw = JSON.stringify({ layers: "4.5" })
    const out = CoerceArgs.coerceToolCallInput(raw, schema)
    expect(JSON.parse(out as string)).toEqual({ layers: "4.5" })
  })

  it("is idempotent — coercing an already-coerced input is a no-op", () => {
    const raw = JSON.stringify({ targets: '["daemon"]' })
    const once = CoerceArgs.coerceToolCallInput(raw, schema)
    const twice = CoerceArgs.coerceToolCallInput(once, schema)
    expect(twice).toBe(once) // second pass returns same reference
  })
})

describe("CoerceArgs.jsonSchemaOf", () => {
  it("extracts the raw schema from an AI SDK jsonSchema() wrapper", () => {
    const wrapped = { inputSchema: jsonSchema(schema as Record<string, unknown>) }
    expect(CoerceArgs.jsonSchemaOf(wrapped)).toMatchObject({ type: "object" })
  })

  it("accepts a tool whose inputSchema is already a raw schema object", () => {
    expect(CoerceArgs.jsonSchemaOf({ inputSchema: schema })).toBe(schema)
  })

  it("returns undefined for a tool with no inputSchema", () => {
    expect(CoerceArgs.jsonSchemaOf({})).toBeUndefined()
    expect(CoerceArgs.jsonSchemaOf(undefined)).toBeUndefined()
  })
})
