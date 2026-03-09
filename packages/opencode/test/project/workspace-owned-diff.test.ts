import { computeOwnedSessionDirtyDiff } from "../../src/project/workspace"
import type { Snapshot } from "../../src/snapshot"
import type { MessageV2 } from "../../src/session/message-v2"

const toolMessage = (tool: string, input: Record<string, unknown>) =>
  ({
    info: { id: `${tool}-assistant`, role: "assistant" },
    parts: [
      {
        type: "tool",
        tool,
        state: { status: "completed", input },
      },
    ],
  }) as any as MessageV2.WithParts

const userSummaryMessage = (id: string, diffs: Snapshot.FileDiff[]) =>
  ({
    info: {
      id,
      role: "user",
      summary: { diffs },
    },
    parts: [],
  }) as any as MessageV2.WithParts

describe("project.workspace.owned-diff", () => {
  test("matches only files explicitly written by the session and still equal to current dirty content", () => {
    const current: Snapshot.FileDiff[] = [
      { file: "a.ts", before: "old", after: "session-final", additions: 1, deletions: 0, status: "modified" },
      { file: "b.ts", before: "old", after: "other-session", additions: 1, deletions: 0, status: "modified" },
    ]
    const messages = [
      toolMessage("write", { filePath: "a.ts" }),
      toolMessage("write", { filePath: "b.ts" }),
      userSummaryMessage("u1", [
        { file: "a.ts", before: "old", after: "session-final", additions: 1, deletions: 0, status: "modified" },
      ]),
      userSummaryMessage("u2", [
        { file: "b.ts", before: "old", after: "session-version", additions: 1, deletions: 0, status: "modified" },
      ]),
    ]

    expect(computeOwnedSessionDirtyDiff(current, messages)).toEqual([
      { file: "a.ts", before: "old", after: "session-final", additions: 1, deletions: 0, status: "modified" },
    ])
  })

  test("ignores summary-only diffs without explicit mutating tool attribution", () => {
    const current: Snapshot.FileDiff[] = [
      { file: "a.ts", before: "old", after: "session-final", additions: 1, deletions: 0, status: "modified" },
    ]
    const messages = [
      userSummaryMessage("u1", [
        { file: "a.ts", before: "old", after: "session-final", additions: 1, deletions: 0, status: "modified" },
      ]),
    ]

    expect(computeOwnedSessionDirtyDiff(current, messages)).toEqual([])
  })

  test("tracks apply_patch targets and normalizes line endings", () => {
    const current: Snapshot.FileDiff[] = [
      { file: "src/foo.ts", before: "old", after: "line1\nline2", additions: 2, deletions: 0, status: "modified" },
    ]
    const messages = [
      toolMessage("apply_patch", { patchText: "*** Begin Patch\n*** Update File: src/foo.ts\n*** End Patch" }),
      userSummaryMessage("u1", [
        { file: "src\\foo.ts/", before: "old", after: "line1\r\nline2", additions: 2, deletions: 0, status: "modified" },
      ]),
    ]

    expect(computeOwnedSessionDirtyDiff(current, messages)).toEqual([
      { file: "src/foo.ts", before: "old", after: "line1\nline2", additions: 2, deletions: 0, status: "modified" },
    ])
  })
})
