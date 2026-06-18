import { describe, expect, test } from "bun:test"
import { PostCompaction } from "./post-compaction"

describe("PostCompaction", () => {
  const ITEMS: PostCompaction.FollowUp[] = [
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

  test("summary addendum and gather/registry stay retired (no runtime-state resend)", async () => {
    // The summary addendum and provider machinery remain fully retired: the
    // anchor summary must not carry re-sent runtime state (duplicate authority).
    expect(PostCompaction.buildSummaryAddendum(ITEMS)).toBe("")
    expect(await PostCompaction.gather("ses_test")).toEqual([])
    expect(PostCompaction.listRegistered()).toEqual([])
  })

  test("buildContinueText re-arms a STATELESS directive that leaks no runtime state", () => {
    // bug_20260618_compaction_continue_injection_empty_text_runloop_stall:
    // the Continue directive must be non-empty so injectContinueAfterAnchor
    // actually writes the synthetic user msg (else the runloop stalls at
    // no_user_after_compaction) — but it must carry ZERO runtime state, so the
    // retirement's real invariant (no duplicate authority) is preserved.
    const continuation = PostCompaction.buildContinueText(ITEMS)
    expect(continuation.length).toBeGreaterThan(0)
    for (const it of ITEMS) {
      if (it.continueHint) expect(continuation).not.toContain(it.continueHint)
      if (it.summaryBody) expect(continuation).not.toContain(it.summaryBody)
    }
    // Stateless even with no items at all (the production path: gather() === []).
    expect(PostCompaction.buildContinueText([]).length).toBeGreaterThan(0)
  })
})
