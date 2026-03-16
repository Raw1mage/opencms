import { describe, expect, it } from "bun:test"
import { getCronPreloadedContext, getPreloadedContextForCron } from "./light-context"

describe("cron light context", () => {
  it("produces minimal context with job metadata", () => {
    const ctx = getCronPreloadedContext({
      jobName: "daily-report",
      jobId: "job-123",
      runId: "run-abc",
    })

    expect(ctx).toContain('mode="cron-light"')
    expect(ctx).toContain("<job_name>daily-report</job_name>")
    expect(ctx).toContain("<job_id>job-123</job_id>")
    expect(ctx).toContain("<run_id>run-abc</run_id>")
    expect(ctx).toContain("lightweight mode")
    // Should NOT contain workspace file references
    expect(ctx).not.toContain("cwd_listing")
    expect(ctx).not.toContain("readme_summary")
  })

  it("delegates to fallback when lightContext is false", async () => {
    let fallbackCalled = false
    const ctx = await getPreloadedContextForCron({
      lightContext: false,
      jobName: "test",
      jobId: "j",
      runId: "r",
      fallback: async () => {
        fallbackCalled = true
        return "<preloaded_context>full</preloaded_context>"
      },
    })

    expect(fallbackCalled).toBe(true)
    expect(ctx).toContain("full")
  })

  it("uses cron context when lightContext is true", async () => {
    let fallbackCalled = false
    const ctx = await getPreloadedContextForCron({
      lightContext: true,
      jobName: "test",
      jobId: "j",
      runId: "r",
      fallback: async () => {
        fallbackCalled = true
        return "should not be called"
      },
    })

    expect(fallbackCalled).toBe(false)
    expect(ctx).toContain("cron-light")
  })
})
