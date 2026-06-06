import { describe, expect, it } from "bun:test"
import { SessionProcessor } from "./processor"

/**
 * isTransientCapacityError must be a STRICT subset of temporary errors: only
 * Anthropic 529 "Overloaded" / 503 get the in-place short-retry. Real rate
 * limits (429), quota, and auth failures must NOT match — otherwise we would
 * retry a genuine cooldown in place instead of rotating.
 * @event_20260606_claude-cli-phantom-accounts-529-and-login-label
 */
describe("isTransientCapacityError", () => {
  const fn = SessionProcessor.isTransientCapacityError

  it("matches Anthropic overloaded_error (the incident shape)", () => {
    expect(fn({ message: '{"error":{"details":null,"type":"overloaded_error","message":"Overloaded"}}' })).toBe(true)
  })

  it("matches a plain Overloaded message", () => {
    expect(fn({ message: "Overloaded" })).toBe(true)
  })

  it("matches HTTP 529 and 503 by status", () => {
    expect(fn({ status: 529 })).toBe(true)
    expect(fn({ statusCode: 503 })).toBe(true)
  })

  it("does NOT match a real 429 rate limit", () => {
    expect(fn({ status: 429, message: "rate limit exceeded" })).toBe(false)
  })

  it("does NOT match quota / auth / generic server errors", () => {
    expect(fn({ message: "quota exceeded" })).toBe(false)
    expect(fn({ status: 401, message: "unauthorized" })).toBe(false)
    expect(fn({ status: 500, message: "internal server error" })).toBe(false)
  })

  it("does NOT match a non-error value", () => {
    expect(fn(undefined)).toBe(false)
    expect(fn("just a string")).toBe(false)
  })
})
