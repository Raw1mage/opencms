import { describe, expect, test } from "bun:test"
import { shouldAutoOpenAuthorization } from "./dialog-connect-provider"

describe("dialog connect provider oauth auto-open", () => {
  test("does not auto-open by default", () => {
    expect(shouldAutoOpenAuthorization()).toBe(false)
  })

  test("keeps global no-auto-open policy stable across repeated checks", () => {
    expect(shouldAutoOpenAuthorization()).toBe(false)
  })
})
