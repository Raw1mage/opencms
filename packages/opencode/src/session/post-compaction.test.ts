import { describe, expect, test } from "bun:test"
import { PostCompaction } from "./post-compaction"

describe("PostCompaction", () => {
  test("does not resend runtime state in summary or continue renderers", async () => {
    const items: PostCompaction.FollowUp[] = [
      {
        kind: "todolist",
        title: "Todolist",
        summaryBody: "first todo projection",
        continueHint: "first todo hint",
      },
      {
        kind: "todolist",
        title: "Todolist duplicate",
        summaryBody: "second todo projection",
        continueHint: "second todo hint",
      },
      {
        kind: "working-cache",
        title: "Working Cache",
        summaryBody: "cache projection",
        continueHint: "cache hint",
      },
    ]

    const summary = PostCompaction.buildSummaryAddendum(items)
    expect(summary).toBe("")

    const continuation = PostCompaction.buildContinueText(items)
    expect(continuation).toBe("")

    expect(await PostCompaction.gather("ses_test")).toEqual([])
    expect(PostCompaction.listRegistered()).toEqual([])
  })
})
