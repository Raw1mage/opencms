import { Log } from "../util/log"
import { Session } from "../session"
import { Bus } from "../bus"
import type { CronDelivery, CronDeliveryStatus, CronRunOutcome } from "./types"

/**
 * Delivery routing for cron run outcomes (D.1.5).
 *
 * Supports three modes:
 *   - "none": no delivery, result stays in run-log only
 *   - "announce": post summary to main session as a system message
 *   - "webhook": HTTP POST to configured URL with bearer auth
 *
 * IDEF0 reference: A13 (Route Delivery Output)
 * GRAFCET reference: opencode_a1_grafcet.json step S6
 */
export namespace CronDeliveryRouter {
  const log = Log.create({ service: "cron.delivery" })

  const MAX_ANNOUNCE_LENGTH = 4000

  export type DeliveryResult = {
    status: CronDeliveryStatus
    error?: string
  }

  export async function deliver(input: {
    delivery: CronDelivery | undefined
    outcome: CronRunOutcome
    jobName: string
    jobId: string
    runId: string
  }): Promise<DeliveryResult> {
    const { delivery, outcome, jobName, jobId, runId } = input

    if (!delivery || delivery.mode === "none") {
      return { status: "not-requested" }
    }

    try {
      if (delivery.mode === "announce") {
        return await deliverAnnounce({ delivery, outcome, jobName, jobId, runId })
      }
      if (delivery.mode === "webhook") {
        return await deliverWebhook({ delivery, outcome, jobName, jobId, runId })
      }
      return { status: "not-requested" }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      log.error("delivery failed", { jobId, runId, mode: delivery.mode, error })
      return { status: "not-delivered", error }
    }
  }

  async function deliverAnnounce(input: {
    delivery: CronDelivery
    outcome: CronRunOutcome
    jobName: string
    jobId: string
    runId: string
  }): Promise<DeliveryResult> {
    const { outcome, jobName, runId, delivery } = input

    let summary = formatAnnounceSummary({ jobName, runId, outcome })
    if (summary.length > MAX_ANNOUNCE_LENGTH) {
      summary = summary.slice(0, MAX_ANNOUNCE_LENGTH - 20) + "\n... (truncated)"
    }

    if (delivery.announceSessionID) {
      // Post to specific session via bus event
      Bus.publish("cron.delivery.announce", {
        sessionID: delivery.announceSessionID,
        text: summary,
        jobId: input.jobId,
        runId,
      })
    }

    log.info("announced", { jobId: input.jobId, runId })
    return { status: "delivered" }
  }

  async function deliverWebhook(input: {
    delivery: CronDelivery
    outcome: CronRunOutcome
    jobName: string
    jobId: string
    runId: string
  }): Promise<DeliveryResult> {
    const { delivery, outcome, jobName, jobId, runId } = input

    if (!delivery.webhookUrl) {
      return { status: "not-delivered", error: "no webhook URL configured" }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (delivery.webhookBearerToken) {
      headers["Authorization"] = `Bearer ${delivery.webhookBearerToken}`
    }

    const body = JSON.stringify({
      event: "cron.run.completed",
      jobId,
      jobName,
      runId,
      status: outcome.status,
      error: outcome.error,
      summary: outcome.summary,
      durationMs: outcome.durationMs,
      timestamp: Date.now(),
    })

    const response = await fetch(delivery.webhookUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      const error = `webhook returned ${response.status}: ${response.statusText}`
      log.warn("webhook non-ok", { jobId, runId, status: response.status })
      if (delivery.bestEffort) {
        return { status: "not-delivered", error }
      }
      throw new Error(error)
    }

    log.info("webhook delivered", { jobId, runId })
    return { status: "delivered" }
  }

  function formatAnnounceSummary(input: {
    jobName: string
    runId: string
    outcome: CronRunOutcome
  }): string {
    const { jobName, runId, outcome } = input
    const statusEmoji = outcome.status === "ok" ? "OK" : outcome.status === "error" ? "ERROR" : "SKIPPED"
    const duration = outcome.durationMs ? ` (${Math.round(outcome.durationMs / 1000)}s)` : ""

    let text = `[cron: ${jobName}] ${statusEmoji}${duration}\nRun: ${runId.slice(0, 8)}`
    if (outcome.summary) {
      text += `\n${outcome.summary}`
    }
    if (outcome.error) {
      text += `\nError: ${outcome.error}`
    }
    return text
  }
}
