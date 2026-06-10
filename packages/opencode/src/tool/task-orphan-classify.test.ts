import { describe, expect, it } from "bun:test"
import { classifyOrphanFinish } from "./task"

/**
 * Guards the daemon-restart orphan reconcile classification
 * (issue_20260611_3r-orphans-active-subagent-eternal-wait).
 *
 * The classifier decides whether the parent learns its subagent *died*
 * (interrupted mid-run by a 3R restart) or *finished* (terminal finish
 * landed on disk in the death window). Mislabeling a death as anything
 * other than worker_dead is the eternal-wait bug; mislabeling a real
 * finish as worker_dead would throw away the child's result.
 */
describe("classifyOrphanFinish", () => {
  it("interrupted child (no finish) → worker_dead/worker_exited", () => {
    // THE BUG CASE: worker died with the daemon, child never reached a
    // terminal finish. Parent must learn the subagent died.
    expect(classifyOrphanFinish(undefined)).toEqual({ status: "worker_dead", finish: "worker_exited" })
  })

  it("unknown / non-terminal finish → worker_dead (interrupted)", () => {
    expect(classifyOrphanFinish("worker_exited")).toEqual({ status: "worker_dead", finish: "worker_exited" })
    expect(classifyOrphanFinish("no_progress_timeout")).toEqual({ status: "worker_dead", finish: "worker_exited" })
    expect(classifyOrphanFinish("")).toEqual({ status: "worker_dead", finish: "worker_exited" })
  })

  it("death-window terminal finish is preserved, not mislabeled as dead", () => {
    expect(classifyOrphanFinish("stop")).toEqual({ status: "success", finish: "stop" })
    expect(classifyOrphanFinish("error")).toEqual({ status: "error", finish: "error" })
    expect(classifyOrphanFinish("length")).toEqual({ status: "error", finish: "length" })
    expect(classifyOrphanFinish("canceled")).toEqual({ status: "canceled", finish: "canceled" })
    expect(classifyOrphanFinish("rate_limited")).toEqual({ status: "rate_limited", finish: "rate_limited" })
    expect(classifyOrphanFinish("quota_low")).toEqual({ status: "quota_low", finish: "quota_low" })
  })

  it("content-filter finish → content_filter, never success or worker_dead", () => {
    // A content-filtered child reaches a terminal finish on disk like any
    // natural stop; it must be classified as content_filter so the parent
    // does not mistake the empty turn for a successful result
    // (issues/subagent-content-filter-false-success.md).
    expect(classifyOrphanFinish("content-filter")).toEqual({ status: "content_filter", finish: "content-filter" })
  })
})
