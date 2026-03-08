import { describe, expect, test } from "bun:test"
import { getFileViewSessionScopeDirectory, getFileViewWorkspaceDirectory } from "./view-cache"

describe("file view cache workspace directory helpers", () => {
  test("prefers explicit workspace directory for workspace fallback scope", () => {
    expect(getFileViewWorkspaceDirectory("/repo/sandbox-a", "/repo")).toBe("/repo")
  })

  test("keeps session scope on original directory when session id exists", () => {
    expect(getFileViewSessionScopeDirectory("/repo/sandbox-a", "session-1", "/repo")).toBe("/repo/sandbox-a")
  })

  test("uses workspace directory when there is no session id", () => {
    expect(getFileViewSessionScopeDirectory("/repo/sandbox-a", undefined, "/repo")).toBe("/repo")
  })
})
