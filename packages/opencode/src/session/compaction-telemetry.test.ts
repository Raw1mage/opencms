import { describe, expect, it } from "bun:test"

import {
  buildBoundaryRoutingTelemetry,
  buildCompactionPredicateTelemetry,
  buildContextBudgetTelemetry,
  buildKindChainTelemetry,
} from "./compaction-telemetry"

describe("compaction telemetry builders", () => {
  it("builds predicate telemetry without raw prompt content", () => {
    const telemetry = buildCompactionPredicateTelemetry({
      sessionID: "ses_test",
      step: 3,
      outcome: "fire",
      reason: "authorization: bearer secret-token " + "x".repeat(500),
      observed: "cache-aware",
      currentInputTokens: 75_000,
      modelContextWindow: 100_000,
      predictedCacheMiss: "miss",
      hasLastFinished: true,
      hasCompactionRequest: false,
      isSubagent: false,
    })

    expect(telemetry.surface).toBe("compaction_predicate")
    expect(telemetry.ctxRatio).toBe(0.75)
    expect(telemetry.reason).toContain("[REDACTED]")
    expect(telemetry.reason?.length).toBeLessThanOrEqual(240)
    expect(JSON.stringify(telemetry)).not.toContain("secret-token")
  })

  it("builds provider-aware kind-chain telemetry", () => {
    const telemetry = buildKindChainTelemetry({
      observed: "overflow",
      providerId: "codex",
      isSubscription: true,
      ctxRatio: 0.92,
      codexServerPriorityRatio: 0.8,
      chain: ["low-cost-server", "narrative", "replay-tail", "llm-agent"],
    })

    expect(telemetry.surface).toBe("compaction_kind_chain")
    expect(telemetry.chain[0]).toBe("low-cost-server")
    expect(telemetry.isSubscription).toBe(true)
  })

  it("builds context-budget telemetry without prompt body", () => {
    const telemetry = buildContextBudgetTelemetry({
      emitted: true,
      window: 200_000,
      used: 110_000,
      ratio: 0.55,
      status: "yellow",
      cacheRead: 10_000,
      cacheHitRate: 0.08,
    })

    expect(telemetry.surface).toBe("context_budget")
    expect(telemetry.emitted).toBe(true)
    expect(JSON.stringify(telemetry)).not.toContain("<context_budget>")
  })

  it("builds boundary-routing telemetry without raw content", () => {
    const raw = "raw attachment body " + "z".repeat(1_000)
    const telemetry = buildBoundaryRoutingTelemetry({
      boundary: "user_attachment",
      action: "attachment_ref",
      refID: "prt_test",
      mime: "text/plain",
      byteSize: raw.length,
      estTokens: 300,
      thresholdBytes: 128,
      previewBytes: 64,
      truncated: true,
      hasFilename: true,
      reason: "api_key=super-secret " + raw,
    })

    expect(telemetry.surface).toBe("big_content_boundary")
    expect(telemetry.action).toBe("attachment_ref")
    expect(telemetry.reason).toContain("[REDACTED]")
    expect(telemetry.reason?.length).toBeLessThanOrEqual(240)
    expect(JSON.stringify(telemetry)).not.toContain("super-secret")
  })
})
