import { describe, expect, test } from "bun:test"
import { ToastShowInput, TuiEvent } from "./event"

describe("TuiEvent.ToastShow", () => {
  test("accepts unstamped toast publish input", () => {
    const parsed = ToastShowInput.parse({
      message: "Show now",
      variant: "info",
      duration: 5_000,
      scope: "user",
    })

    expect(parsed.scope).toBe("user")
  })

  test("accepts scoped toast freshness metadata", () => {
    const parsed = TuiEvent.ToastShow.properties.parse({
      message: "System restarting",
      variant: "info",
      duration: 15_000,
      emittedAt: 1_000,
      ttlMs: 15_000,
      scope: "system",
    })

    expect(parsed.scope).toBe("system")
    expect(parsed.ttlMs).toBe(15_000)
  })

  test("rejects missing freshness metadata", () => {
    expect(() =>
      TuiEvent.ToastShow.properties.parse({
        message: "Old format",
        variant: "info",
        scope: "user",
      }),
    ).toThrow()
  })

  test("rejects invalid scope", () => {
    expect(() =>
      TuiEvent.ToastShow.properties.parse({
        message: "Bad scope",
        variant: "info",
        emittedAt: 1_000,
        ttlMs: 5_000,
        scope: "global",
      }),
    ).toThrow()
  })
})
