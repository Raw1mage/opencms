import { describe, expect, test } from "bun:test"
import { isSessionCatalogMutation } from "./session-storage-watch"

describe("isSessionCatalogMutation", () => {
  test("matches top-level session storage entries", () => {
    expect(isSessionCatalogMutation("ses_abc123.db")).toBe(true)
    expect(isSessionCatalogMutation("ses_abc123")).toBe(true)
    expect(isSessionCatalogMutation("ses_abc123.db-wal")).toBe(true)
  })

  test("ignores unrelated files", () => {
    expect(isSessionCatalogMutation("migration")).toBe(false)
    expect(isSessionCatalogMutation("project")).toBe(false)
    expect(isSessionCatalogMutation(undefined)).toBe(false)
  })
})
