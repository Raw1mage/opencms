import { describe, expect, test } from "bun:test"
import {
  createEmptyWorkspaceAttachmentSummary,
  summarizeWorkspaceAttachments,
  type WorkspaceAttachmentDescriptor,
} from "../../src/project/workspace"

describe("project.workspace.attachments", () => {
  test("creates empty attachment summary", () => {
    expect(createEmptyWorkspaceAttachmentSummary()).toEqual({
      sessionIds: [],
      activeSessionId: undefined,
      ptyIds: [],
      previewIds: [],
      workerIds: [],
      draftKeys: [],
      fileTabKeys: [],
      commentKeys: [],
    })
  })

  test("summarizes attachment ownership descriptors", () => {
    const descriptors: WorkspaceAttachmentDescriptor[] = [
      { type: "session", ownership: "session", key: "s-1", active: true },
      { type: "pty", ownership: "workspace", key: "pty-1" },
      { type: "preview", ownership: "workspace", key: "preview-1" },
      { type: "draft", ownership: "session_with_workspace_default", key: "draft-1" },
      { type: "file_tab", ownership: "session_with_workspace_default", key: "tab-1" },
      { type: "comment", ownership: "session_with_workspace_default", key: "comment-1" },
      { type: "worker", ownership: "workspace", key: "worker-1" },
    ]

    expect(summarizeWorkspaceAttachments(descriptors)).toEqual({
      sessionIds: ["s-1"],
      activeSessionId: "s-1",
      ptyIds: ["pty-1"],
      previewIds: ["preview-1"],
      workerIds: ["worker-1"],
      draftKeys: ["draft-1"],
      fileTabKeys: ["tab-1"],
      commentKeys: ["comment-1"],
    })
  })
})
