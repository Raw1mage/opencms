import type { JSONSchema7 } from "ai"

/**
 * Schema-aware coercion of stringified typed tool args.
 *
 * Root cause (bug_20260617 + DD-21 Active Loader): Claude (driven via the
 * claude-cli impersonation) emits tool calls in its INNATE ANTML text format —
 *
 *   <invoke name="system-manager_restart_self">
 *   <parameter name="targets">["daemon"]</parameter>
 *   </invoke>
 *
 * — far more often than "intermittently" because the Active Loader keeps the
 * wire `tools[]` pinned to ALWAYS_PRESENT for cache stability, so EVERY deferred
 * tool is off the wire and the model has no structured tool_use slot for it.
 * provider-claude's salvageAntmlInvokes captures every <parameter> body as a
 * STRING and JSON.stringify's the bag, so object/number/array/boolean args reach
 * the tool as JSON-string literals (`"[\"daemon\"]"`) and fail schema validation
 * while plain-string args pass.
 *
 * This module is the SINGLE schema-aware repair: for each top-level property the
 * schema declares as a concrete NON-string type, if the incoming value is a
 * string, JSON.parse it and adopt the parsed value ONLY when its runtime type
 * matches the declared type.
 *
 * Conservative by construction — NOT a silent fallback:
 *   - a property whose schema ALSO permits `string` is left untouched (ambiguous)
 *   - a parse failure leaves the original string in place
 *   - a runtime/declared type mismatch leaves the original string in place
 * Anything ambiguous passes through unchanged so the tool's own validation still
 * runs and surfaces a real error the model can self-correct against.
 */
export namespace CoerceArgs {
  function tryParseJson(value: string): unknown | undefined {
    const trimmed = value.trim()
    if (trimmed === "") return undefined
    try {
      return JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }

  // Returns the declared non-string types iff the schema names a concrete type
  // that does NOT include "string"; null otherwise (= "do not coerce").
  function declaredNonStringTypes(propSchema: JSONSchema7): Set<string> | null {
    const t = propSchema.type
    let types: string[]
    if (typeof t === "string") types = [t]
    else if (Array.isArray(t)) types = t.map((x) => String(x))
    else return null
    if (types.length === 0) return null
    if (types.includes("string")) return null // ambiguous — leave as-is
    const usable = types.filter(
      (x) => x === "object" || x === "array" || x === "number" || x === "integer" || x === "boolean",
    )
    if (usable.length === 0) return null
    return new Set(usable)
  }

  function runtimeTypeMatches(value: unknown, declared: Set<string>): boolean {
    for (const t of declared) {
      switch (t) {
        case "object":
          if (value !== null && typeof value === "object" && !Array.isArray(value)) return true
          break
        case "array":
          if (Array.isArray(value)) return true
          break
        case "number":
          if (typeof value === "number" && Number.isFinite(value)) return true
          break
        case "integer":
          if (typeof value === "number" && Number.isInteger(value)) return true
          break
        case "boolean":
          if (typeof value === "boolean") return true
          break
      }
    }
    return false
  }

  /**
   * Coerce a decoded args object against its JSON schema. Returns the SAME
   * reference when nothing changed (cheap no-op detection for callers).
   */
  export function coerceArgsToSchema(
    args: Record<string, unknown>,
    schema: JSONSchema7 | undefined,
  ): Record<string, unknown> {
    const props = schema?.properties as Record<string, JSONSchema7> | undefined
    if (!props) return args
    let out: Record<string, unknown> | null = null
    for (const [key, value] of Object.entries(args)) {
      if (typeof value !== "string") continue
      const propSchema = props[key]
      if (!propSchema || typeof propSchema !== "object") continue
      const declared = declaredNonStringTypes(propSchema)
      if (!declared) continue
      const parsed = tryParseJson(value)
      if (parsed === undefined) continue
      if (!runtimeTypeMatches(parsed, declared)) continue
      if (!out) out = { ...args }
      out[key] = parsed
    }
    return out ?? args
  }

  /**
   * Convenience wrapper for the tool-call repair seam (llm.ts): the AI SDK hands
   * tool-call input as a JSON STRING. Parse → coerce → re-serialize. Returns the
   * ORIGINAL rawInput verbatim (preserving formatting) when there is nothing to
   * coerce — non-string input, empty, unparseable, non-object root, or no field
   * changed. Only re-serializes when a field was actually coerced.
   */
  export function coerceToolCallInput(rawInput: string, schema: JSONSchema7 | undefined): string
  export function coerceToolCallInput(rawInput: unknown, schema: JSONSchema7 | undefined): unknown
  export function coerceToolCallInput(rawInput: unknown, schema: JSONSchema7 | undefined): unknown {
    if (typeof rawInput !== "string") return rawInput
    const trimmed = rawInput.trim()
    if (trimmed === "") return rawInput
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return rawInput
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return rawInput
    const coerced = coerceArgsToSchema(parsed as Record<string, unknown>, schema)
    if (coerced === parsed) return rawInput // no-op — keep original bytes
    return JSON.stringify(coerced)
  }

  /** Extract the raw JSON schema from an AI SDK tool's wrapped inputSchema. */
  export function jsonSchemaOf(tool: unknown): JSONSchema7 | undefined {
    const s = (tool as { inputSchema?: { jsonSchema?: unknown } } | undefined)?.inputSchema
    if (!s) return undefined
    return ((s as { jsonSchema?: unknown }).jsonSchema ?? s) as JSONSchema7
  }
}
