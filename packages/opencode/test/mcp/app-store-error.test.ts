import { test, expect, describe } from "bun:test"
import { z } from "zod/v4"
import { McpAppStore } from "../../src/mcp/app-store"

/**
 * Tests for structured error classification.
 * See plans/mcp_per_user_socket_rca/errors.md E4 and
 * design.md DD-8.
 */

describe("classifyStoreError — structured cause", () => {
  test("EACCES → fs_permission", () => {
    const err = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    expect(McpAppStore.classifyStoreError(err)).toBe("fs_permission")
  })

  test("EPERM → fs_permission", () => {
    const err = Object.assign(new Error("EPERM"), { code: "EPERM" })
    expect(McpAppStore.classifyStoreError(err)).toBe("fs_permission")
  })

  test("EROFS → fs_permission", () => {
    const err = Object.assign(new Error("EROFS: read-only filesystem"), { code: "EROFS" })
    expect(McpAppStore.classifyStoreError(err)).toBe("fs_permission")
  })

  test("SyntaxError → json_parse", () => {
    const err = new SyntaxError("Unexpected token in JSON")
    expect(McpAppStore.classifyStoreError(err)).toBe("json_parse")
  })

  test("ZodError → schema_validation", () => {
    const schema = z.object({ x: z.number() })
    const result = schema.safeParse({ x: "not a number" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(McpAppStore.classifyStoreError(result.error)).toBe("schema_validation")
    }
  })

  test("unknown error → unknown", () => {
    expect(McpAppStore.classifyStoreError(new Error("???"))).toBe("unknown")
    expect(McpAppStore.classifyStoreError("string error")).toBe("unknown")
    expect(McpAppStore.classifyStoreError(null)).toBe("unknown")
  })
})

describe("StoreError schema — cause + tier fields", () => {
  test("constructs with cause and tier", () => {
    const err = new McpAppStore.StoreError({
      operation: "addApp",
      reason: "denied",
      cause: "fs_permission",
      tier: "user",
    })
    expect(err.data.cause).toBe("fs_permission")
    expect(err.data.tier).toBe("user")
    expect(err.data.operation).toBe("addApp")
    expect(err.data.reason).toBe("denied")
  })

  test("cause and tier are optional (backward compat)", () => {
    const err = new McpAppStore.StoreError({
      operation: "addApp",
      reason: "legacy",
    })
    expect(err.data.cause).toBeUndefined()
    expect(err.data.tier).toBeUndefined()
  })

  test("StoreErrorCause enum lists all four classes + unknown", () => {
    const values = ["fs_permission", "json_parse", "schema_validation", "tier_conflict", "unknown"]
    for (const v of values) {
      expect(McpAppStore.StoreErrorCause.safeParse(v).success).toBe(true)
    }
    expect(McpAppStore.StoreErrorCause.safeParse("invalid_cause").success).toBe(false)
  })
})
