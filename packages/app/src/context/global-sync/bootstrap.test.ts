import { describe, expect, test } from "bun:test"
import { fetchWorkspaceCurrent } from "./bootstrap"

describe("global-sync workspace bootstrap helpers", () => {
  test("fetchWorkspaceCurrent reads workspace snapshot from runtime API", async () => {
    const fetchMock = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            workspaceId: "workspace:1",
            projectId: "project-1",
            directory: "/repo",
            kind: "root",
            origin: "local",
            lifecycleState: "active",
            attachments: {
              sessionIds: ["session-1"],
              activeSessionId: "session-1",
              ptyIds: ["pty-1"],
              previewIds: [],
              workerIds: [],
              draftKeys: [],
              fileTabKeys: [],
              commentKeys: [],
            },
          }),
          { status: 200 },
        ),
      { preconnect: fetch.preconnect },
    ) as typeof fetch

    await expect(fetchWorkspaceCurrent({ baseUrl: "http://localhost:4096", fetch: fetchMock })).resolves.toEqual({
      workspaceId: "workspace:1",
      projectId: "project-1",
      directory: "/repo",
      kind: "root",
      origin: "local",
      lifecycleState: "active",
      attachments: {
        sessionIds: ["session-1"],
        activeSessionId: "session-1",
        ptyIds: ["pty-1"],
        previewIds: [],
        workerIds: [],
        draftKeys: [],
        fileTabKeys: [],
        commentKeys: [],
      },
    })
  })

  test("workspace helpers no-op when fetch context is unavailable", async () => {
    await expect(fetchWorkspaceCurrent({})).resolves.toBeUndefined()
  })
})
