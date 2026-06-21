/**
 * harness/freerun-mode — bridge between opencode's session machinery and
 * the freerun engine.
 *
 * This module is intentionally narrow: it answers
 *
 *   - "Is this session freerun-mode?"  (read provider config)
 *   - "Does it have an active root ContextNode?" (read storage)
 *   - "Drive one iteration of this session's engine."
 *
 * Downstream callers (workflow-runner / prompt.ts / a CLI smoke command)
 * decide WHEN to invoke these. The full autonomous-loop ↔ engine wiring
 * (deciding session vs node-tree as the unit of work) lives in those
 * callers, not here.
 */

import * as path from "path"
import { Global } from "@/global"
import { Config } from "@/config/config"
import { Bus } from "@/bus"
import { Session } from "."
import { Log } from "../util/log"
import { Engine } from "../freerun/runtime/engine"
import { FreerunLlmClient } from "../freerun/provider/llm-client"
import { NodeFS } from "../freerun/storage/node-fs"
import { Tree } from "../freerun/storage/tree"
import { MetaFS } from "../freerun/storage/meta-fs"
import { PickNext } from "../freerun/policy/pick-next"
import { FreerunTodoProjection } from "../freerun/todo-projection"
import { buildPlanTaskSeedInput, type PlanTaskCandidate } from "../freerun/plan-task"
import { Todo } from "./todo"
import {
  ExperimentConfig,
  hashExperimentConfig,
  type ContextNode,
  type TriggerMode,
  type FreerunFinalStatus,
  type GoalBinding,
} from "../freerun/types"

const log = Log.create({ service: "session.freerun-bridge" })

export namespace FreerunBridge {
  // ============================================================================
  // Detection
  // ============================================================================

  export interface FreerunSessionInfo {
    providerId: string
    modelId: string
    baseUrl: string
    apiKey?: string
  }

  /**
   * Returns the provider info if the given opencode session is configured to
   * use a freerun-mode provider; null otherwise.
   */
  export async function detect(sessionID: string): Promise<FreerunSessionInfo | null> {
    const session = await Session.get(sessionID).catch(() => null)
    if (!session) return null

    const cfg = await Config.get().catch(() => null)
    if (!cfg) return null

    // Walk: session.execution → provider config in opencode.json → mode field.
    // Note: execution is set lazily after the first LLM bind, so detect()
    // returns null on a brand-new session before its first turn. That's
    // intentional — the prompt.ts freerun branch handles fresh sessions
    // using the incoming message's model field directly.
    const providerId = session.execution?.providerId
    const modelId = session.execution?.modelID
    if (!providerId || !modelId) return null
    if (session.workflow?.freerunOverride === "off") return null

    const providerCfg = (
      cfg.provider as
        | Record<
            string,
            { lite?: boolean; mode?: "full" | "lite" | "freerun"; options?: { baseURL?: string; apiKey?: string } }
          >
        | undefined
    )?.[providerId]
    if (providerCfg?.mode !== "freerun" && session.workflow?.freerunOverride !== "on") return null

    return {
      providerId,
      modelId,
      baseUrl: providerCfg?.options?.baseURL ?? "",
      apiKey: providerCfg?.options?.apiKey,
    }
  }

  /**
   * Returns true when the session has a root ContextNode persisted on disk
   * (i.e. a freerun engine session has been seeded for it).
   */
  export async function hasActiveRoot(sessionID: string): Promise<boolean> {
    const treeDir = path.join(sessionStorageRoot(sessionID), "tree")
    try {
      const ids = await NodeFS.list(sessionID, Global.Path.data)
      return ids.length > 0
    } catch {
      void treeDir
      return false
    }
  }

  /**
   * Higher-level gate for the autonomous-loop dispatcher. Combines provider
   * detection + meta.json status + pickNext-virtual into a single classifier.
   *   - "active": engine should drive one iteration on this session next
   *   - "paused": freerun-pause set; loop should stop with reason="paused"
   *   - "settled": no actionable node remains; loop should stop with
   *                reason="freerun_settled"
   *   - "no_root": freerun is selected, but no ContextNode root was seeded
   *   - "none": not a freerun session at all
   *   - "blocked": engine self-blocked (no progress possible)
   */
  export type SessionState =
    | { kind: "active"; info: FreerunSessionInfo }
    | { kind: "paused"; status: FreerunFinalStatus }
    | { kind: "settled"; status: FreerunFinalStatus }
    | { kind: "blocked"; status: FreerunFinalStatus }
    | { kind: "no_root"; info: FreerunSessionInfo }
    | { kind: "none" }

  export async function classify(sessionID: string): Promise<SessionState> {
    const info = await detect(sessionID)
    if (info === null) return { kind: "none" }
    if (!(await hasActiveRoot(sessionID))) return { kind: "no_root", info }

    const meta = await MetaFS.read(sessionID, Global.Path.data).catch(() => null)
    const status = meta?.final_status ?? "in_progress"
    if (status === "paused") return { kind: "paused", status }
    if (status === "blocked") return { kind: "blocked", status }
    if (status === "done" || status === "cap_reached" || status === "user_interrupted" || status === "error") {
      return { kind: "settled", status }
    }

    // status === in_progress — verify pickNext still finds something actionable.
    try {
      const cfg = ExperimentConfig.parse({})
      const tree = await Tree.load(sessionID, Global.Path.data)
      const pick = PickNext.pick(tree, cfg)
      if (pick.kind === "settled") return { kind: "settled", status: "done" }
      return { kind: "active", info }
    } catch {
      return { kind: "none" }
    }
  }

  /**
   * Seed a root ContextNode for this session from a goal string. Idempotent —
   * if a root already exists, this is a noop (the caller checks hasActiveRoot
   * first when it wants to differentiate first-init from continuation).
   */
  export async function seedRoot(input: {
    sessionID: string
    title: string
    body: string
    nowIso?: () => string
    goalBinding?: GoalBinding
  }): Promise<void> {
    const existing = await hasActiveRoot(input.sessionID)
    if (existing) return
    const now = input.nowIso?.() ?? new Date().toISOString()
    const root: ContextNode = {
      id: "root",
      parent_id: null,
      children_ids: [],
      title: input.title,
      body: input.body,
      mode: "pending-plan",
      created_at: now,
      iteration_count: 0,
      observations: [],
      decisions: [],
      blockers: [],
      results: null,
      next_intent: "",
      consolidated_summary: null,
      goal_binding: input.goalBinding ?? { source: "conversation-goal", goal_text: input.body },
    }
    await NodeFS.write(input.sessionID, root, Global.Path.data)
    await syncTodoProjection(input.sessionID).catch(() => undefined)
    log.info("freerun root seeded", { sessionID: input.sessionID, title: input.title })
  }

  export async function seedRootFromPlanTask(input: {
    sessionID: string
    task: PlanTaskCandidate
    nowIso?: () => string
  }): Promise<void> {
    const seed = buildPlanTaskSeedInput(input.task)
    await seedRoot({
      sessionID: input.sessionID,
      title: seed.title,
      body: seed.body,
      goalBinding: seed.goalBinding,
      nowIso: input.nowIso,
    })
  }

  // ============================================================================
  // Drive
  // ============================================================================

  export interface DriveOptions {
    sessionID: string
    /** Trigger mode tag for telemetry. Defaults to "goal". */
    triggerMode?: TriggerMode
    /** Maximum iterations for this single drive call. Defaults to 1 (one step at a time). */
    iterationCapOverride?: number
    /** Optional tool catalog passthrough; defaults to no tools (engine will run in think-only mode for execution). */
    toolCatalog?: Array<{ name: string; description?: string; parameters?: unknown }>
    /** Optional tool dispatcher — workflow-runner integration will plug opencode's tool dispatch here. */
    toolDispatcher?: { dispatch: (name: string, args: unknown) => Promise<string> }
  }

  /**
   * Drive the freerun engine for `iterationCapOverride` steps against the
   * given session. Throws if the session is not freerun-eligible or has no
   * root ContextNode.
   */
  export async function drive(opts: DriveOptions): Promise<Engine.RunSummary> {
    const info = await detect(opts.sessionID)
    if (!info) throw new Error(`session ${opts.sessionID} is not in freerun mode`)
    if (!(await hasActiveRoot(opts.sessionID))) {
      throw new Error(`session ${opts.sessionID} has no freerun root ContextNode — call seedRoot first`)
    }
    if (!info.baseUrl) {
      throw new Error(`provider ${info.providerId} has no options.baseURL — cannot build LlmClient`)
    }

    const config = ExperimentConfig.parse({})

    // Default tool surface: opencode's existing tools via the bridge.
    // Caller can override by supplying their own catalog + dispatcher.
    const { OpencodeToolBridge } = await import("../freerun/provider/opencode-tool-bridge")
    const toolCatalog = opts.toolCatalog ?? (await OpencodeToolBridge.buildCatalog())
    const toolDispatcher = opts.toolDispatcher ?? OpencodeToolBridge.buildDispatcher({ sessionID: opts.sessionID })

    const client = FreerunLlmClient.create({
      baseUrl: info.baseUrl,
      modelId: info.modelId,
      apiKey: info.apiKey,
      toolDispatcher,
      sessionId: opts.sessionID,
    })

    const tree = await Tree.load(opts.sessionID, Global.Path.data)
    const rootId = tree.rootId
    const expCfgId = hashExperimentConfig(config)

    const summary = await Engine.run({
      sessionId: opts.sessionID,
      dataHome: Global.Path.data,
      config,
      llm: client,
      toolCatalog,
      providerId: info.providerId,
      userId: ((await Session.get(opts.sessionID).catch(() => null)) as any)?.userID ?? "default",
      triggerMode: opts.triggerMode ?? "goal",
      rootNodeId: rootId,
      experimentConfigId: expCfgId,
      iterationCapOverride: opts.iterationCapOverride, // undefined → Engine.run uses ExperimentConfig.iteration_cap (default 500)
    })
    await syncTodoProjection(opts.sessionID).catch((err) => {
      log.warn("freerun todo projection sync failed", {
        sessionID: opts.sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return summary
  }

  export async function syncTodoProjection(sessionID: string): Promise<Todo.Info[]> {
    const tree = await Tree.load(sessionID, Global.Path.data)
    const todos = FreerunTodoProjection.project(tree)
    await Todo.setDerived({ sessionID, todos })
    return todos
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  function sessionStorageRoot(sessionID: string): string {
    return path.join(Global.Path.data, "storage", "freerun", sessionID)
  }

  /** Subscribe to Bus exposure — placeholder for future cross-cutting subscribers. */
  export function attachBusObserver(): void {
    // Reserved. Observers can already subscribe via Bus.subscribe(FreerunBus.Iteration…)
    // — this hook is here for future single-call attach if needed.
    void Bus
  }
}
