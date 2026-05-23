import { describe, expect, test } from "bun:test"
import { isSessionCatalogMutation } from "./session-storage-watch"

describe("isSessionCatalogMutation", () => {
  test("matches top-level session storage catalog renames", () => {
    expect(isSessionCatalogMutation("rename", "ses_abc123.db")).toBe(true)
    expect(isSessionCatalogMutation("rename", "ses_abc123")).toBe(true)
    expect(isSessionCatalogMutation("rename", "ses_abc123.db-wal")).toBe(true)
  })

  test("ignores content changes on session entries", () => {
    expect(isSessionCatalogMutation("change", "ses_abc123")).toBe(false)
    expect(isSessionCatalogMutation("change", "ses_abc123.db-wal")).toBe(false)
  })

  test("ignores unrelated files", () => {
    expect(isSessionCatalogMutation("rename", "migration")).toBe(false)
    expect(isSessionCatalogMutation("rename", "project")).toBe(false)
    expect(isSessionCatalogMutation("rename", undefined)).toBe(false)
  })
})
