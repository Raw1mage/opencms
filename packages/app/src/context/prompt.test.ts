import { beforeAll, describe, expect, mock, test } from "bun:test"

let getPromptWorkspaceDirectory: (dir: string, workspaceDirectory?: string) => string
let getPromptSessionScopeDirectory: (dir: string, id: string | undefined, workspaceDirectory?: string) => string

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useParams: () => ({}),
  }))
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  mock.module("./global-sync", () => ({
    useGlobalSync: () => ({
      child: () => [{ workspace: undefined }, () => undefined],
    }),
  }))
  const mod = await import("./prompt")
  getPromptWorkspaceDirectory = mod.getPromptWorkspaceDirectory
  getPromptSessionScopeDirectory = mod.getPromptSessionScopeDirectory
})

describe("prompt workspace directory helpers", () => {
  test("prefers explicit workspace directory for workspace fallback scope", () => {
    expect(getPromptWorkspaceDirectory("/repo/sandbox-a", "/repo")).toBe("/repo")
  })

  test("keeps session scope on original directory when session id exists", () => {
    expect(getPromptSessionScopeDirectory("/repo/sandbox-a", "session-1", "/repo")).toBe("/repo/sandbox-a")
  })

  test("uses workspace directory when there is no session id", () => {
    expect(getPromptSessionScopeDirectory("/repo/sandbox-a", undefined, "/repo")).toBe("/repo")
  })
})
