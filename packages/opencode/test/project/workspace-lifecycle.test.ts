import { describe, expect, test } from "bun:test"
import {
  buildDerivedWorkspace,
  markWorkspaceActive,
  markWorkspaceArchived,
  markWorkspaceDeleting,
  markWorkspaceFailed,
  markWorkspaceResetting,
} from "../../src/project/workspace"

describe("project.workspace.lifecycle", () => {
  test("marks workspace through lifecycle states", () => {
    const workspace = buildDerivedWorkspace({
      projectId: "project-1",
      directory: "/tmp/workspace-derived",
    })

    expect(markWorkspaceResetting(workspace).lifecycleState).toBe("resetting")
    expect(markWorkspaceDeleting(workspace).lifecycleState).toBe("deleting")
    expect(markWorkspaceArchived(workspace).lifecycleState).toBe("archived")
    expect(markWorkspaceActive(workspace).lifecycleState).toBe("active")
    expect(markWorkspaceFailed(workspace).lifecycleState).toBe("failed")
  })
})
