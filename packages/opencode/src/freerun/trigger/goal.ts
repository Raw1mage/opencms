/**
 * harness/freerun-mode — goal trigger.
 *
 * Seeds a new freerun session from a user-supplied goal string and drives
 * the engine until the cap is reached or the tree settles. The goal text
 * becomes the root ContextNode.body; root.mode starts at `pending-plan`
 * so the engine's first iteration is a decomposition pass.
 *
 * Companion to trigger/cron.ts (scheduled launch from a task definition
 * file) and trigger/watchdog.ts (event-driven launch).
 */

import { Engine } from "../runtime/engine"
import { FreerunLlmClient } from "../provider/llm-client"
import { NodeFS } from "../storage/node-fs"
import { Tree } from "../storage/tree"
import {
  ExperimentConfig,
  hashExperimentConfig,
  type ContextNode,
  type ExperimentConfig as ExperimentConfigT,
  type GoalBinding,
} from "../types"

export namespace GoalTrigger {
  export interface StartOptions {
    /** Existing or new freerun session id. */
    sessionId: string
    /** Root data dir (`Global.Path.data`). */
    dataHome: string
    /** Free-form goal text — becomes root.body. */
    goal: string
    /** Short title (defaults to first 80 chars of goal). */
    title?: string
    /** Provider id (must be freerun-mode in opencode.json). */
    providerId: string
    /** Model id (sent in request body). */
    modelId: string
    /** OpenAI-compatible base URL (e.g. http://127.0.0.1:7731 or .../v1). */
    baseUrl: string
    /** Optional API key. */
    apiKey?: string
    /** User id for per-user isolation telemetry. */
    userId: string
    /** Iteration cap for this run. Default: experiment config's iteration_cap. */
    iterationCapOverride?: number
    /** Override default ExperimentConfig. */
    config?: ExperimentConfigT
    /** Optional tool dispatcher — when omitted, execution iterations run think-only. */
    toolDispatcher?: { dispatch: (name: string, args: unknown) => Promise<string> }
    /** Optional tool catalog declaration (names + schemas) for execution rounds. */
    toolCatalog?: Array<{ name: string; description?: string; parameters?: unknown }>
    /** Optional plan/task binding. Defaults to conversation-goal. */
    goalBinding?: GoalBinding
  }

  export interface StartResult extends Engine.RunSummary {
    sessionId: string
    rootNodeId: string
    wasResumed: boolean
  }

  /**
   * Seed (idempotent) + drive. If a root ContextNode already exists for this
   * sessionId, the goal/title are NOT overwritten — the session resumes from
   * whatever state is on disk. To force a fresh session, supply a new
   * sessionId.
   */
  export async function start(opts: StartOptions): Promise<StartResult> {
    const config = opts.config ?? ExperimentConfig.parse({})

    // Seed root if not present.
    const ids = await NodeFS.list(opts.sessionId, opts.dataHome).catch(() => [] as string[])
    const wasResumed = ids.length > 0
    if (!wasResumed) {
      const now = new Date().toISOString()
      const root: ContextNode = {
        id: "root",
        parent_id: null,
        children_ids: [],
        title: opts.title ?? opts.goal.slice(0, 80),
        body: opts.goal,
        mode: "pending-plan",
        created_at: now,
        iteration_count: 0,
        observations: [],
        decisions: [],
        blockers: [],
        results: null,
        next_intent: "",
        consolidated_summary: null,
        goal_binding: opts.goalBinding ?? { source: "conversation-goal", goal_text: opts.goal },
      }
      await NodeFS.write(opts.sessionId, root, opts.dataHome)
    }

    // Resolve current root id (may have been renamed by a prior session, but
    // by convention is always "root").
    const tree = await Tree.load(opts.sessionId, opts.dataHome)
    const rootId = tree.rootId

    const client = FreerunLlmClient.create({
      baseUrl: opts.baseUrl,
      modelId: opts.modelId,
      apiKey: opts.apiKey,
      sessionId: opts.sessionId,
      toolDispatcher: opts.toolDispatcher,
    })

    const summary = await Engine.run({
      sessionId: opts.sessionId,
      dataHome: opts.dataHome,
      config,
      llm: client,
      toolCatalog: opts.toolCatalog ?? [],
      providerId: opts.providerId,
      userId: opts.userId,
      triggerMode: "goal",
      rootNodeId: rootId,
      experimentConfigId: hashExperimentConfig(config),
      iterationCapOverride: opts.iterationCapOverride,
    })

    return { ...summary, sessionId: opts.sessionId, rootNodeId: rootId, wasResumed }
  }
}
