import { describe, expect, it } from "bun:test"
import type { JSONSchema7 } from "ai"
import { MCP } from "."

// Regression coverage for bug_20260617: MCP typed args (object/number/array/
// boolean) arrived stringified via the Claude ANTML-salvage tool-call path and
// failed downstream JSON-schema validation. coerceArgsToSchema repairs them by
// re-parsing string values whose inputSchema declares a concrete non-string
// type, only adopting the parsed value when its runtime type matches.

describe("MCP.coerceArgsToSchema", () => {
  const schema = {
    type: "object",
    properties: {
      out_dir: { type: "string" },
      wall_thickness_mm: { type: "number" },
      layers: { type: "integer" },
      enabled: { type: "boolean" },
      tags: { type: "array" },
      constraints: { type: "object" },
    },
  } satisfies JSONSchema7

  it("parses a stringified object back to an object", () => {
    const out = MCP.coerceArgsToSchema({ constraints: '{"board_outline": {"width_mm": 130, "height_mm": 65}}' }, schema)
    expect(out.constraints).toEqual({ board_outline: { width_mm: 130, height_mm: 65 } })
  })

  it("parses a stringified number back to a number", () => {
    const out = MCP.coerceArgsToSchema({ wall_thickness_mm: "2.5" }, schema)
    expect(out.wall_thickness_mm).toBe(2.5)
  })

  it("parses a stringified integer back to an integer", () => {
    const out = MCP.coerceArgsToSchema({ layers: "4" }, schema)
    expect(out.layers).toBe(4)
  })

  it("parses a stringified boolean back to a boolean", () => {
    const out = MCP.coerceArgsToSchema({ enabled: "true" }, schema)
    expect(out.enabled).toBe(true)
  })

  it("parses a stringified array back to an array", () => {
    const out = MCP.coerceArgsToSchema({ tags: '["a", "b"]' }, schema)
    expect(out.tags).toEqual(["a", "b"])
  })

  it("leaves a genuine string argument untouched", () => {
    const out = MCP.coerceArgsToSchema({ out_dir: "incoming/foo" }, schema)
    expect(out.out_dir).toBe("incoming/foo")
  })

  it("leaves already-typed values untouched", () => {
    const input = { constraints: { a: 1 }, wall_thickness_mm: 2.5 }
    const out = MCP.coerceArgsToSchema(input, schema)
    expect(out.constraints).toEqual({ a: 1 })
    expect(out.wall_thickness_mm).toBe(2.5)
  })

  it("does not coerce a number-typed field when the parsed value is not numeric", () => {
    const out = MCP.coerceArgsToSchema({ wall_thickness_mm: "not-a-number" }, schema)
    expect(out.wall_thickness_mm).toBe("not-a-number")
  })

  it("does not coerce an integer-typed field when the parsed value is a float", () => {
    const out = MCP.coerceArgsToSchema({ layers: "4.5" }, schema)
    expect(out.layers).toBe("4.5")
  })

  it("does not coerce when the parsed runtime type mismatches the declared type", () => {
    // object-typed field receiving a JSON array literal — type mismatch, keep string
    const out = MCP.coerceArgsToSchema({ constraints: "[1,2,3]" }, schema)
    expect(out.constraints).toBe("[1,2,3]")
  })

  it("leaves fields whose schema also permits string (ambiguous) untouched", () => {
    const ambiguous = {
      type: "object",
      properties: { val: { type: ["string", "number"] } },
    } satisfies JSONSchema7
    const out = MCP.coerceArgsToSchema({ val: "2.5" }, ambiguous)
    expect(out.val).toBe("2.5")
  })

  it("leaves unknown properties (not in schema) untouched", () => {
    const out = MCP.coerceArgsToSchema({ mystery: "{}" }, schema)
    expect(out.mystery).toBe("{}")
  })

  it("is a no-op when schema has no properties", () => {
    const input = { wall_thickness_mm: "2.5" }
    const out = MCP.coerceArgsToSchema(input, undefined)
    expect(out).toBe(input)
  })

  it("ignores empty-string values (cannot parse)", () => {
    const out = MCP.coerceArgsToSchema({ constraints: "" }, schema)
    expect(out.constraints).toBe("")
  })

  it("preserves untouched args by identity when nothing is coerced", () => {
    const input = { out_dir: "x" }
    const out = MCP.coerceArgsToSchema(input, schema)
    expect(out).toBe(input)
  })
})
