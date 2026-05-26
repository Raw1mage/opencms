/**
 * harness/freerun-mode — engine driver.
 *
 * Thin loop on top of Iterate.once + Consolidate.consolidate. The
 * workflow-runner integration (Phase 1.17-1.19) will call this; today
 * the same entry is reachable from a smoke-test script or a future
 * `opencode freerun-goal` CLI.
 *
 * Loop semantics (one full session run):
 *   while iteration < iteration_cap:
 *     result = Iterate.once(...)
 *     if result.kind === "settled": break
 *     Consolidate.consolidate(...)  -- walks up from the touched node
 *     emit heartbeat every N iterations
 *
 * The session lifecycle events (`freerun.session.started`,
 * `freerun.session.terminated`) are emitted here so any entry point gets
 * them for free.
 */

import { Iterate } from "./iterate"
import { Consolidate } from "./consolidate"
import { FreerunBus } from "../observability/bus"
import { BusSink } from "../observability/bus-sink"
import type { ExperimentConfig, FreerunFinalStatus, TriggerMode } from "../types"

export namespace Engine {
  export interface RunOptions {
    sessionId: string
    dataHome: string
    config: ExperimentConfig
    /** LLM client implementing both iterate + consolidate seams (provider/llm-client.ts builds one). */
    llm: Iterate.LlmClient & Consolidate.SummarizeClient
    /** Tool catalog passed to execution iterations. */
    toolCatalog: Iterate.LlmClient extends infer _ ? any[] : never
    /** Telemetry: provider id of the LLM in use. */
    providerId: string
    /** Telemetry: user id (per-user isolation). */
    userId: string
    /** Telemetry: trigger mode that started this session. */
    triggerMode: TriggerMode
    /** Telemetry: id of the root ContextNode. */
    rootNodeId: string
    /** Telemetry: hash of the frozen experiment config. */
    experimentConfigId: string
    /** Override: stop after this many iterations even if cap allows more. */
    iterationCapOverride?: number
  }

  export interface RunSummary {
    totalIterations: number
    finalStatus: FreerunFinalStatus
    blockedNodeIds: string[]
  }

  export async function run(opts: RunOptions): Promise<RunSummary> {
    const cap = opts.iterationCapOverride ?? opts.config.iteration_cap
    const blockedNodeIds: string[] = []
    let iterations = 0
    let finalStatus: FreerunFinalStatus = "in_progress"

    // Install per-session JSONL sink so the behavior timeline lands on disk
    // alongside the ContextNode tree. Cleaned up at session end.
    const sink = BusSink.install({ dataHome: opts.dataHome, sessionId: opts.sessionId })

    await FreerunBus.emit.sessionStarted({
      sessionID: opts.sessionId,
      triggerMode: opts.triggerMode,
      providerID: opts.providerId,
      userID: opts.userId,
      rootNodeID: opts.rootNodeId,
      experimentConfigID: opts.experimentConfigId,
      protocolVersion: "v0",
    })

    try {
      while (iterations < cap) {
        const iter = await Iterate.once({
          sessionId: opts.sessionId,
          dataHome: opts.dataHome,
          config: opts.config,
          llm: opts.llm,
          toolCatalog: opts.toolCatalog as any,
          iteration: iterations,
        })

        if (iter.kind === "settled") {
          finalStatus = "done"
          break
        }
        if (iter.kind === "blocked") {
          blockedNodeIds.push(iter.nodeId)
          // Engine doesn't stop on a single blocked node — pickNext will try a
          // different actionable branch next iteration. Stop only when the
          // whole tree settles or cap is hit.
        }
        const touchedNodeId = iter.kind === "advanced" ? iter.nodeId : iter.nodeId
        await Consolidate.consolidate({
          sessionId: opts.sessionId,
          dataHome: opts.dataHome,
          config: opts.config,
          llm: opts.llm,
          seedNodeId: touchedNodeId,
          iteration: iterations,
        })

        iterations++
      }
      if (iterations >= cap && finalStatus === "in_progress") {
        finalStatus = "cap_reached"
      }
    } catch (err) {
      finalStatus = "error"
      await FreerunBus.emit.iterationHalted({
        sessionID: opts.sessionId,
        iteration: iterations,
        reason: `engine loop error: ${err instanceof Error ? err.message : String(err)}`,
        errors: [String(err)],
      })
    }

    await FreerunBus.emit.sessionTerminated({
      sessionID: opts.sessionId,
      finalStatus,
      totalIterations: iterations,
      pathMetricsSummary: { blockedNodeIds, sinkWriteCount: sink.writeCount() },
    })

    sink.dispose()
    return { totalIterations: iterations, finalStatus, blockedNodeIds }
  }
}
