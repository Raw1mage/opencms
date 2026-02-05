import { describe, expect, test } from "bun:test"
import { accessTokenExpired } from "../../../src/plugin/antigravity/plugin/auth"

describe("antigravity auth", () => {
  test("returns true when access token missing", () => {
    const auth = {
      type: "oauth" as const,
      refresh: "rt",
      access: "",
      expires: Date.now() + 120000,
    }
    expect(accessTokenExpired(auth)).toBe(true)
  })

  test("returns true when access token expired", () => {
    const auth = {
      type: "oauth" as const,
      refresh: "rt",
      access: "at",
      expires: Date.now() - 1000,
    }
    expect(accessTokenExpired(auth)).toBe(true)
  })

  test("returns false when access token valid", () => {
    const auth = {
      type: "oauth" as const,
      refresh: "rt",
      access: "at",
      expires: Date.now() + 180000,
    }
    expect(accessTokenExpired(auth)).toBe(false)
  })
})
