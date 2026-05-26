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

import * as fs from "fs/promises"
import * as path from "path"
import { Iterate } from "./iterate"
import { Consolidate } from "./consolidate"
import { FreerunBus } from "../observability/bus"
import { BusSink } from "../observability/bus-sink"
import { MetaFS } from "../storage/meta-fs"
import type { ExperimentConfig, FreerunFinalStatus, TriggerMode } from "../types"

/**
 * Load project conventions + operational rules from disk. Both are optional;
 * a missing file is silently skipped (the engine still runs, just without
 * that block in the prompt). Resolution order:
 *
 *   AGENTS.md:
 *     1. ~/.config/opencode/AGENTS.md     (user global)
 *     2. <Instance.directory>/AGENTS.md   (per-project)
 *   Concatenated with a "## ---" separator if both present.
 *
 *   SYSTEM.md:
 *     1. ~/.config/opencode/prompts/SYSTEM.md  (user override)
 *     2. /usr/local/share/opencode/templates/prompts/SYSTEM.md  (installed default)
 *
 * Read once per session at Engine.run start; cached for the session's lifetime.
 */
async function loadRulesContent(opts: { directory?: string }): Promise<{
  agentsMdContent?: string
  systemMdContent?: string
}> {
  const home = process.env.HOME ?? "/home/pkcs12"
  const projectDir = opts.directory ?? process.cwd()

  async function readIfPresent(p: string): Promise<string | null> {
    try {
      return await fs.readFile(p, "utf-8")
    } catch {
      return null
    }
  }

  const [userAgents, projectAgents] = await Promise.all([
    readIfPresent(path.join(home, ".config", "opencode", "AGENTS.md")),
    readIfPresent(path.join(projectDir, "AGENTS.md")),
  ])
  const agentsParts: string[] = []
  if (userAgents) agentsParts.push(userAgents.trim())
  if (projectAgents) agentsParts.push(projectAgents.trim())
  const agentsMdContent = agentsParts.length > 0 ? agentsParts.join("\n\n---\n\n") : undefined

  let systemMdContent: string | undefined
  for (const p of [
    path.join(home, ".config", "opencode", "prompts", "SYSTEM.md"),
    "/usr/local/share/opencode/templates/prompts/SYSTEM.md",
  ]) {
    const t = await readIfPresent(p)
    if (t) {
      systemMdContent = t.trim()
      break
    }
  }

  return { agentsMdContent, systemMdContent }
}

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
    const startedAt = new Date().toISOString()

    // Pre-flight: respect a paused state. The CLI freerun-pause writes
    // final_status="paused"; the daemon-side autonomous loop relies on
    // bridge.detect short-circuiting before reaching here, but for direct
    // callers (CLI / scripts) we also bail at the engine boundary.
    const priorMeta = await MetaFS.read(opts.sessionId, opts.dataHome).catch(() => null)
    if (priorMeta?.final_status === "paused") {
      return { totalIterations: priorMeta.total_iterations, finalStatus: "paused", blockedNodeIds: [] }
    }

    // Install per-session JSONL sink so the behavior timeline lands on disk
    // alongside the ContextNode tree. Cleaned up at session end.
    const sink = BusSink.install({ dataHome: opts.dataHome, sessionId: opts.sessionId })

    // Write or refresh meta.json at session start (idempotent across resumes).
    if (priorMeta === null) {
      await MetaFS.write(opts.sessionId, {
        session_id: opts.sessionId,
        trigger_mode: opts.triggerMode,
        provider_id: opts.providerId,
        user_id: opts.userId,
        root_node_id: opts.rootNodeId,
        started_at: startedAt,
        final_status: "in_progress",
        total_iterations: 0,
        experiment_config: opts.config,
        experiment_config_id: opts.experimentConfigId,
        protocol_version: "v0",
      }, opts.dataHome).catch(() => undefined)
    } else if (priorMeta.final_status !== "in_progress") {
      // Resuming a terminal session: flip back to in_progress so the engine
      // can continue (and the next-iteration loop can see new actionable work).
      await MetaFS.patch(opts.sessionId, opts.dataHome, { final_status: "in_progress" }).catch(() => undefined)
    }

    await FreerunBus.emit.sessionStarted({
      sessionID: opts.sessionId,
      triggerMode: opts.triggerMode,
      providerID: opts.providerId,
      userID: opts.userId,
      rootNodeID: opts.rootNodeId,
      experimentConfigID: opts.experimentConfigId,
      protocolVersion: "v0",
    })

    // Load AGENTS.md / SYSTEM.md once per session and pass through to every
    // iteration. These supply project conventions + operational rules to the
    // model so the freerun engine inherits the same safety/governance
    // language the turn-mode pipeline uses.
    const rules = await loadRulesContent({ directory: process.cwd() }).catch(() => ({}))

    try {
      while (iterations < cap) {
        const iter = await Iterate.once({
          sessionId: opts.sessionId,
          dataHome: opts.dataHome,
          config: opts.config,
          llm: opts.llm,
          toolCatalog: opts.toolCatalog as any,
          iteration: iterations,
          agentsMdContent: rules.agentsMdContent,
          systemMdContent: rules.systemMdContent,
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

    await MetaFS.patch(opts.sessionId, opts.dataHome, {
      final_status: finalStatus,
      total_iterations: (priorMeta?.total_iterations ?? 0) + iterations,
      ended_at: new Date().toISOString(),
    }).catch(() => undefined)

    sink.dispose()
    return { totalIterations: iterations, finalStatus, blockedNodeIds }
  }
}
