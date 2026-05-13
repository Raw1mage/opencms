import { describe, expect, it } from "bun:test"
import { renderNoticeAddendum } from "./prompt"
import type { MessageV2 } from "./message-v2"

/**
 * Snapshot tests for renderNoticeAddendum per
 * plans/subagent_self_rotation/spec.md §"Failure transparency via
 * read_subsession". Verifies that every non-success status carries an
 * inline `read_subsession(sessionID="<id>")` hint and that success
 * status does not.
 */

function makeNotice(overrides: Partial<MessageV2.PendingSubagentNotice>): MessageV2.PendingSubagentNotice {
  return {
    jobId: "job_test",
    childSessionID: "ses_test_child",
    status: "success",
    finish: "stop",
    elapsedMs: 12_345,
    at: new Date(0).toISOString(),
    ...overrides,
  } as MessageV2.PendingSubagentNotice
}

const READ_SUBSESSION_NEEDLE = 'read_subsession(sessionID="ses_test_child")'

describe("renderNoticeAddendum — read_subsession hint", () => {
  it("success: no hint", () => {
    const out = renderNoticeAddendum(makeNotice({ status: "success", finish: "stop" }))
    expect(out).not.toContain("read_subsession")
    expect(out).toContain("status=success")
  })

  it("error: hint present", () => {
    const out = renderNoticeAddendum(makeNotice({ status: "error", finish: "error" }))
    expect(out).toContain(READ_SUBSESSION_NEEDLE)
  })

  it("canceled: hint present", () => {
    const out = renderNoticeAddendum(makeNotice({ status: "canceled", finish: "canceled" }))
    expect(out).toContain(READ_SUBSESSION_NEEDLE)
    expect(out).toContain("canceled")
  })

  it("rate_limited: hint present plus exhaustion guidance", () => {
    const out = renderNoticeAddendum(
      makeNotice({
        status: "rate_limited",
        finish: "rate_limited",
        errorDetail: { resetsInSeconds: 600 },
      }),
    )
    expect(out).toContain(READ_SUBSESSION_NEEDLE)
    expect(out).toContain("exhausted its rotation candidates")
    expect(out).toContain("resets_in_seconds=600")
  })

  it("quota_low: hint present plus rotation directive", () => {
    const out = renderNoticeAddendum(
      makeNotice({
        status: "quota_low",
        finish: "quota_low",
        rotateHint: {
          exhaustedAccountId: "acc_x",
          remainingPercent: 3,
          directive: "rotate-before-redispatch",
        },
      }),
    )
    expect(out).toContain(READ_SUBSESSION_NEEDLE)
    expect(out).toContain("Switch to a different account")
    expect(out).toContain("exhaustedAccount=acc_x")
  })

  it("worker_dead: hint present", () => {
    const out = renderNoticeAddendum(
      makeNotice({ status: "worker_dead", finish: "worker_exited" }),
    )
    expect(out).toContain(READ_SUBSESSION_NEEDLE)
    expect(out).toContain("did not complete cleanly")
  })

  it("silent_kill: hint present", () => {
    const out = renderNoticeAddendum(
      makeNotice({ status: "silent_kill", finish: "no_progress_timeout" }),
    )
    expect(out).toContain(READ_SUBSESSION_NEEDLE)
  })
})
