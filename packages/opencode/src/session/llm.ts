import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { getCapabilities } from "@/provider/capabilities"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  convertToModelMessages,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  type UIMessage,
  tool,
  jsonSchema,
} from "ai"
import { clone, mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Todo } from "./todo"
import { BusSink } from "../freerun/observability/bus-sink"
import { FreerunBus } from "../freerun/observability/bus"
import { Global } from "@/global"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { streamIdleTimeoutMs, usesFirstChunkWatchdog } from "./stream-watchdog"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"
import { Token } from "@/util/token"
import { WorkingCache } from "./working-cache"
import { CoerceArgs } from "@/tool/coerce-args"

import z from "zod"
import { findFallback, type ModelVector, type FallbackStrategy, isVectorRateLimited } from "@/account/rotation3d"
import { getRateLimitTracker } from "@/account/rotation"
import { withRotationCoalesce } from "@/account/rotation/coalesce"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { TuiEvent, publishToastTraced } from "@/cli/cmd/tui/event"
import { debugCheckpoint } from "@/util/debug"
import { RateLimitJudge, isRateLimitError, isAuthError, CodexFamilyExhausted } from "@/account/rate-limit-judge"

import { RequestMonitor } from "@/account/monitor"
import ENABLEMENT from "./prompt/enablement.json"
import { logSessionAccountAudit, resolveAccountAuditSource } from "./account-audit"
import { resolveProviderBillingMode } from "@/provider/billing-mode"
import { SkillLayerRegistry } from "./skill-layer-registry"
import { buildSkillLayerRegistrySystemPart } from "./skill-layer-seam"
import { recordSystemBlockHash } from "./cache-miss-diagnostic"
import { buildStaticBlock, resolveFamily, type StaticSystemTuple } from "./static-system-builder"
import {
  buildActiveImageContentBlocks,
  buildPreface,
  type ContextPrefaceMessageOutput,
  type InlineImageContentBlock,
  type InlineImageRefInput,
} from "./context-preface"
import { Tweaks } from "@/config/tweaks"
import { Account } from "../account"
import { ALWAYS_PRESENT_TOOLS } from "@/tool/tool-loader"
import {
  assembleBundles,
  buildAmnesiaNoticeFragment,
  buildEnvironmentContextFragment,
  buildOpencodeAgentInstructionsFragment,
  buildOpencodeProtocolFragment,
  buildRoleIdentityFragment,
  buildUserInstructionsFragment,
  decideAmnesiaInjection,
  FRAGMENT_SEP,
  type ContextFragment,
} from "./context-fragments"
import { Session } from "."
import { InstructionPrompt } from "./instruction"
import path from "path"

/**
 * Bus event for real-time LLM error reporting to the webapp sidebar.
 * Fires for EVERY error in onError — not just rate limits.
 */
export const LlmErrorEvent = BusEvent.define(
  "llm.error",
  z.object({
    providerId: z.string(),
    modelId: z.string(),
    accountId: z.string(),
    sessionID: z.string(),
    status: z.number().optional(),
    message: z.string(),
    timestamp: z.number(),
  }),
)

/**
 * Bus event for rotation chain tracking.
 * Fires every time a fallback rotation executes (from → to).
 */
export const RotationExecutedEvent = BusEvent.define(
  "rotation.executed",
  z.object({
    sessionID: z.string().optional(),
    fromProviderId: z.string(),
    fromModelId: z.string(),
    fromAccountId: z.string(),
    toProviderId: z.string(),
    toModelId: z.string(),
    toAccountId: z.string(),
    reason: z.string(),
    timestamp: z.number(),
  }),
)

export const PromptTelemetryEvent = BusEvent.define(
  "llm.prompt.telemetry",
  z.object({
    sessionID: z.string(),
    promptId: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    accountId: z.string().optional(),
    finalSystemTokens: z.number(),
    finalSystemChars: z.number(),
    finalSystemMessages: z.number(),
    messageCount: z.number(),
    blocks: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        chars: z.number(),
        tokens: z.number(),
        injected: z.boolean(),
        policy: z.string(),
      }),
    ),
    timestamp: z.number(),
  }),
)

/**
 * Attempt to repair tool call arguments when the LLM used wrong parameter
 * names (common with lazy/deferred tools where schema wasn't visible).
 *
 * Strategy:
 * 1. Parse the expected schema's required properties
 * 2. Parse the LLM's provided args
 * 3. If required props are missing, try to map from LLM's provided props
 *    (e.g., LLM sent "content" but schema expects "input")
 * 4. If only one required string prop exists and LLM sent a single string
 *    value under a different name, remap it
 *
 * Returns the repaired JSON string, or undefined if no repair was possible.
 */
function tryRepairToolArgs(
  toolName: string,
  rawInput: string,
  inputSchema: (opts: { toolName: string }) => unknown,
): string | undefined {
  try {
    const schema = inputSchema({ toolName }) as Record<string, unknown> | null
    if (!schema || schema.type !== "object") return undefined

    const props = schema.properties as Record<string, { type?: string }> | undefined
    if (!props) return undefined

    const required = new Set((schema.required as string[]) ?? Object.keys(props))
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(rawInput)
    } catch {
      return undefined
    }
    if (typeof parsed !== "object" || parsed === null) return undefined

    // Check if all required props are already present
    const missing = [...required].filter((k) => !(k in parsed))
    if (missing.length === 0) return undefined // args look fine already

    // Strategy: for each missing required prop, try to find a provided value
    // that matches the expected type
    const repaired = { ...parsed }
    let didRepair = false

    for (const missingKey of missing) {
      const expectedType = props[missingKey]?.type

      // Look for a value under a different name with matching type
      for (const [providedKey, providedVal] of Object.entries(parsed)) {
        if (required.has(providedKey)) continue // don't steal from another required prop
        if (providedKey in props) continue // it's a known optional prop, don't reassign

        const matches =
          expectedType === "string"
            ? typeof providedVal === "string"
            : expectedType === "number"
              ? typeof providedVal === "number"
              : expectedType === "boolean"
                ? typeof providedVal === "boolean"
                : expectedType === "array"
                  ? Array.isArray(providedVal)
                  : true // unknown type, accept anything

        if (matches) {
          repaired[missingKey] = providedVal
          delete repaired[providedKey]
          didRepair = true
          break
        }
      }
    }

    return didRepair ? JSON.stringify(repaired) : undefined
  } catch {
    return undefined
  }
}

export namespace LLM {
  const log = Log.create({ service: "llm" })

  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  // ============================================================================
  // Freerun paper-data sink registry (per-session BusSink + per-session turn counter)
  // ============================================================================
  //
  // events.jsonl is the canonical structured paper-data store. We lazily
  // install a BusSink per session on first LLM.stream call in freerun mode
  // and keep it installed for the daemon's lifetime — there's no clean
  // "session end" hook in opencode's runloop path. Cost is negligible
  // (one global Bus subscriber per active freerun session).
  //
  // Turn counter increments each time LLM.stream fires for a freerun session.
  // (One opencode "turn" = one freerun "iteration" in this architecture.)
  const _freerunSinks = new Map<string, BusSink.InstallHandle>()
  const _freerunTurnIndex = new Map<string, number>()

  function ensureFreerunSink(sessionID: string): BusSink.InstallHandle {
    let h = _freerunSinks.get(sessionID)
    if (!h) {
      h = BusSink.install({ dataHome: Global.Path.data, sessionId: sessionID })
      _freerunSinks.set(sessionID, h)
    }
    return h
  }
  function nextFreerunTurn(sessionID: string): number {
    const n = (_freerunTurnIndex.get(sessionID) ?? -1) + 1
    _freerunTurnIndex.set(sessionID, n)
    return n
  }

  /**
   * Freerun stateless context regeneration — strip dialog history from the
   * LLM payload, replace with a freshly synthesized snapshot of structured
   * state (todos) + the latest user/directive message. UI continues to
   * show full history; only the LLM input gets compacted to current-state.
   *
   * The model thus sees per turn:
   *   [system + FREERUN.md]
   *   [user: <todo snapshot> + <latest directive text>]
   * No prior assistant turns leak in — each round is fresh context.
   */
  /**
   * Stateless rewrite for ModelMessage[] (AI-SDK flat form, what LLM.stream
   * actually carries). Walks back to find the latest "user" role message,
   * builds a new array containing ONLY that message with a state snapshot
   * prepended into its content.
   */
  async function buildFreerunStatelessMessages(sessionID: string, messages: ModelMessage[]): Promise<ModelMessage[]> {
    process.stderr.write(`[freerun-debug] build:entry msgCount=${messages.length}\n`)

    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as any)?.role === "user") {
        lastUserIdx = i
        break
      }
    }
    process.stderr.write(`[freerun-debug] build:lastUserIdx=${lastUserIdx}\n`)
    if (lastUserIdx === -1) return messages

    const todos = await Todo.get(sessionID).catch(() => [] as any[])
    process.stderr.write(`[freerun-debug] build:todosLoaded count=${todos.length}\n`)
    const stateBlock = renderFreerunStateSnapshot(todos as any)

    const latest = messages[lastUserIdx] as any
    // ModelMessage content is either a string or an array of content parts.
    let newContent: any
    if (typeof latest.content === "string") {
      newContent = stateBlock + "\n\n# Latest directive\n" + latest.content
    } else if (Array.isArray(latest.content)) {
      newContent = [{ type: "text", text: stateBlock + "\n\n# Latest directive" }, ...latest.content]
    } else {
      // unknown shape — fall back to original
      process.stderr.write(`[freerun-debug] build:unknown content shape, fallback\n`)
      return messages
    }

    const rebuilt: ModelMessage = { ...latest, content: newContent }
    process.stderr.write(`[freerun-debug] build:returning 1 rebuilt msg\n`)
    return [rebuilt]
  }

  function renderFreerunStateSnapshot(
    todos: ReadonlyArray<{
      id: string
      content: string
      status: "pending" | "in_progress" | "completed" | "blocked"
    }>,
  ): string {
    if (todos.length === 0) {
      return [
        "# Freerun state snapshot",
        "(no todos yet — when you decide on a plan, use TodoWrite to record it; the next turn will see your todos here.)",
        "",
      ].join("\n")
    }
    const lines = ["# Freerun state snapshot", "## Todos (the single source of truth for what you're doing)"]
    const groups: Record<string, Array<(typeof todos)[number]>> = {}
    for (const t of todos) {
      ;(groups[t.status] ??= []).push(t)
    }
    const order: Array<"in_progress" | "pending" | "blocked" | "completed"> = [
      "in_progress",
      "pending",
      "blocked",
      "completed",
    ]
    for (const status of order) {
      const items = groups[status]
      if (!items || items.length === 0) continue
      lines.push(`### ${status} (${items.length})`)
      for (const t of items) lines.push(`- [${status}] ${t.content}`)
    }
    lines.push("")
    return lines.join("\n")
  }

  /**
   * Load FREERUN.md from user-override → installed-default. Returns the file
   * content trimmed, or undefined on miss. Cheap to call per-request — file
   * is ~2KB and OS page cache handles re-reads.
   */
  let _freerunMdCache: { content: string; loadedAt: number } | undefined
  async function loadFreerunMd(): Promise<string | undefined> {
    // 30-second cache to avoid one fs.readFile per LLM call.
    const FRESH_MS = 30_000
    if (_freerunMdCache && Date.now() - _freerunMdCache.loadedAt < FRESH_MS) {
      return _freerunMdCache.content
    }
    const { promises: fs } = await import("fs")
    const path = await import("path")
    const home = process.env.HOME ?? "/home/pkcs12"
    const candidates = [
      path.join(home, ".config", "opencode", "prompts", "FREERUN.md"),
      "/usr/local/share/opencode/templates/prompts/FREERUN.md",
    ]
    for (const p of candidates) {
      try {
        const text = (await fs.readFile(p, "utf-8")).trim()
        if (text) {
          _freerunMdCache = { content: text, loadedAt: Date.now() }
          return text
        }
      } catch {
        continue
      }
    }
    return undefined
  }

  // Toast debouncing for rotation notifications
  const TOAST_DEBOUNCE_MS = 15_000

  let lastRotationToastAt = 0

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    accountId?: string
    agent: Agent.Info
    /**
     * Phase B: per-turn "trailing" system addenda. Carries content that
     * doesn't belong to the static system block or the preface T1/T2 segments
     * — e.g. lazy tool catalog hints, structured-output directives, subagent
     * return notices, processor.ts quota-low wrap-up. Emitted as the
     * trailing content block of the context preface message (per-turn cache
     * invalidation is acceptable here).
     *
     * Pre-Phase-B callers used this as a catch-all that also included
     * preload + env + AGENTS; those three responsibilities now live in the
     * dedicated fields below.
     */
    system: string[]
    /** Phase B (DD-1, DD-2): structured preload for preface T1. */
    preload?: import("./context-preface-types").PreloadParts
    /** Phase B (DD-2): today's date for preface T1 (last item in T1). */
    todaysDate?: string
    /** Phase B (DD-12 L3c): AGENTS.md text. Empty for subagents. */
    agentsMd?: string
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    /**
     * Mutable rendezvous for the stream-idle watchdog pause hook
     * (plans/question-tool_idle-watchdog-false-kill, DD-1).
     *
     * Lifecycle:
     *   1. prompt.ts creates a fresh `{}` per stream and passes the same
     *      reference to both resolveTools(...) and LLM.stream(...).
     *   2. LLM.stream constructs its watchdog, then assigns
     *      `idleWatchdogBox.pause = pauseIdleWatchdog`. The assignment is
     *      what makes it reachable from inside tool ctx.
     *   3. resolve-tools.ts's per-tool wrapper closes over the same box and
     *      reads `idleWatchdogBox.pause` at tool-call time (lazy lookup —
     *      resolveTools runs BEFORE LLM.stream builds the watchdog, so
     *      eager capture would always be undefined).
     *   4. ToolInvoker forwards the function into Tool.Context.pauseIdleWatchdog.
     *   5. Interactive tools (question / permission) call ctx.pauseIdleWatchdog?.()
     *      to disarm the 90s wedge timer while awaiting human input, and
     *      MUST call the returned resume() in a finally block.
     *   6. disarmIdleWatchdog drops the published reference on stream end
     *      so straggler calls cannot revive a dead stream's watchdog.
     *
     * Optional — if absent, the question tool gracefully no-ops via
     * optional-chaining and behaves as before. This is acceptable per
     * design.md DD-2 because the omission path is the pre-fix behavior
     * (no silent masking of a defect).
     */
    idleWatchdogBox?: { pause?: () => () => void }
    lazyTools?: Map<string, Tool>
    toolChoice?: "auto" | "required" | "none" | { type: "tool"; toolName: string }
    contextBudget?: {
      status: "green" | "yellow" | "orange" | "red" | "unknown"
      ratio?: number
      used?: number
      window?: number
      source: "last-finished" | "unavailable"
    }
    retries?: number
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  async function isSubagentSession(sessionID: string): Promise<boolean> {
    const { Session: SessionMod } = await import("@/session")
    // Graceful-degrade for non-persisted (ephemeral) sessions: the stateless
    // completion path (Completion.run) mints a synthetic sessionID that has no
    // storage row, so Session.get throws Storage.NotFoundError. Mirror the
    // .catch(() => undefined) used at the other Session.get callsites in this
    // file (e.g. line ~1379) — a missing session is simply "not a subagent".
    const info = await SessionMod.get(sessionID).catch(() => undefined)
    return !!info?.parentID
  }

  async function resolveParentSessionID(sessionID: string): Promise<string | undefined> {
    const { Session: SessionMod } = await import("@/session")
    const info = await SessionMod.get(sessionID).catch(() => undefined)
    return info?.parentID
  }

  function extractLatestUserText(messages: ModelMessage[]): string {
    const user = [...messages].reverse().find((m) => m.role === "user")
    if (!user) return ""
    const content = user.content
    if (typeof content === "string") return content.toLowerCase()
    if (!Array.isArray(content)) return ""
    return content
      .map((part: any) => {
        if (!part || typeof part !== "object") return ""
        if (typeof part.text === "string") return part.text
        if (typeof part.input === "string") return part.input
        return ""
      })
      .join("\n")
      .toLowerCase()
  }

  interface MatchedRoute {
    intent: string
    prefer: string[]
    notes: string[]
    /** Skill names referenced in `prefer` via the `skill:<name>` convention. */
    skillRefs: string[]
  }

  function getMatchedRoutes(messages: ModelMessage[]): MatchedRoute[] {
    const data = ENABLEMENT as any
    const text = extractLatestUserText(messages).toLowerCase()
    return ((data?.routing?.intent_to_capability ?? []) as any[])
      .filter((route) => (route?.keywords ?? []).some((kw: string) => text.includes(String(kw).toLowerCase())))
      .slice(0, 4)
      .map((route) => {
        const prefer: string[] = route.prefer ?? []
        return {
          intent: route.intent,
          prefer,
          notes: route.notes ?? [],
          skillRefs: prefer
            .map((p) => /^skill:(.+)$/.exec(String(p))?.[1])
            .filter((x): x is string => !!x),
        }
      })
  }

  /**
   * A matched route is "satisfied" when every companion skill it nudges to load
   * is ALREADY present in context (gate #1 — state-aware routing nudge). The
   * model is already on that toolchain, so re-pasting the full routing block +
   * discipline notes every turn is noise + prompt-cache churn. Routes with no
   * skill ref (pure tool routes) are never skill-satisfied and stay verbatim.
   */
  function isRouteSatisfied(route: MatchedRoute, presentSkills: Set<string>): boolean {
    return route.skillRefs.length > 0 && route.skillRefs.every((name) => presentSkills.has(name))
  }

  /**
   * Skill→toolchain bindings derived from the route table: each route pairs a
   * companion `skill:<name>` with the concrete tools that skill drives (e.g.
   * doc-workflow ↔ docxmcp_*). This is the binding gate-A keep-alive keys on —
   * NOT user keywords. Built once from ENABLEMENT; only routes that bind at
   * least one skill to at least one tool are returned.
   */
  function getSkillToolchainBindings(): Array<{ tools: string[]; skills: string[] }> {
    const data = ENABLEMENT as any
    return ((data?.routing?.intent_to_capability ?? []) as any[])
      .map((route) => {
        const prefer: string[] = route.prefer ?? []
        const skills = prefer.map((p) => /^skill:(.+)$/.exec(String(p))?.[1]).filter((x): x is string => !!x)
        const tools = prefer.filter((p) => !/^skill:/.test(String(p))).map((p) => String(p).toLowerCase())
        return { tools, skills }
      })
      .filter((b) => b.skills.length > 0 && b.tools.length > 0)
  }

  /**
   * Tool names the model actually invoked in the current agentic burst (since
   * the last user message). This is the GROUND-TRUTH "skill is in use" signal —
   * what the model did, not what the user typed — that drives keep-alive.
   */
  function extractRecentToolNames(messages: ModelMessage[]): Set<string> {
    const names = new Set<string>()
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "user") break
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue
      for (const part of m.content as any[]) {
        if (part?.type === "tool-call" && typeof part.toolName === "string") {
          names.add(part.toolName.toLowerCase())
        }
      }
    }
    return names
  }

  /**
   * Gate-A keep-alive on the CORRECT signal. A skill is kept resident because
   * its toolchain is being actively invoked — observable runtime fact — not
   * because the user's text happened to contain a hardcoded keyword. Refreshes
   * lastUsedAt for each skill whose bound tools appear in the recent tool-call
   * stream; tool-name matching is containment-based to survive prefix wrapping
   * (e.g. an App-Store `mcpapp-docxmcp_document` still matches `docxmcp_document`).
   * When the model stops calling that toolchain, touches stop and the skill
   * decays normally.
   */
  function keepAliveSkillsByToolUse(sessionID: string, messages: ModelMessage[], now: number) {
    const recentTools = extractRecentToolNames(messages)
    if (recentTools.size === 0) return
    for (const binding of getSkillToolchainBindings()) {
      const used = binding.tools.some((t) => {
        for (const rt of recentTools) if (rt === t || rt.includes(t)) return true
        return false
      })
      if (!used) continue
      for (const skill of binding.skills) SkillLayerRegistry.touch(sessionID, skill, now)
    }
  }

  function shouldInjectEnablementSnapshot(messages: ModelMessage[], presentSkills: Set<string>) {
    if (messages.length <= 1) return true
    // Inject only when there is something NEW to say: a matched route whose
    // companion skill isn't already loaded. Once every matched route is
    // satisfied, the snapshot would just re-nudge an already-loaded toolchain,
    // so suppress it entirely (this is the engine behind the "每回持續注入"
    // symptom in keyword-dense domain sessions, e.g. document work).
    return getMatchedRoutes(messages).some((route) => !isRouteSatisfied(route, presentSkills))
  }

  function getMessageShapeSummary(message: ModelMessage) {
    const content = message.content
    const isArray = Array.isArray(content)
    const parts = isArray ? content : []
    const partTypes = isArray ? parts.map((part: any) => part?.type ?? typeof part) : []
    const hasCacheControl =
      typeof message.providerOptions === "object" && message.providerOptions !== null
        ? JSON.stringify(message.providerOptions).includes("cache")
        : false
    return {
      role: message.role,
      contentType: typeof content,
      partCount: isArray ? parts.length : 0,
      partTypes: partTypes.slice(0, 6),
      hasCacheControl,
      providerOptionKeys:
        message.providerOptions && typeof message.providerOptions === "object"
          ? Object.keys(message.providerOptions)
          : [],
    }
  }

  function collectCacheKeywords(value: unknown, hits = new Set<string>(), path = "root") {
    if (!value || typeof value !== "object") return hits
    if (Array.isArray(value)) {
      value.forEach((item, index) => collectCacheKeywords(item, hits, `${path}[${index}]`))
      return hits
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const currentPath = `${path}.${key}`
      if (/cache/i.test(key)) hits.add(currentPath)
      if (typeof child === "string" && /cache/i.test(child)) hits.add(currentPath)
      collectCacheKeywords(child, hits, currentPath)
    }
    return hits
  }

  function applyToolCallBudget(input: StreamInput, options: Record<string, any>) {
    const cfg = Tweaks.toolCallBudgetSync()
    if (!cfg.enabled) return
    const status = input.contextBudget?.status ?? "unknown"
    const statusMax =
      status === "green"
        ? cfg.greenMax
        : status === "yellow"
          ? cfg.yellowMax
          : status === "orange"
            ? cfg.orangeMax
            : status === "red"
              ? cfg.redMax
              : cfg.unknownMax
    const policyMax = Math.min(statusMax, cfg.absoluteMax)
    const originalMaxToolCalls = options.maxToolCalls
    const originalParallelToolCalls = options.parallelToolCalls
    const existingMax =
      typeof originalMaxToolCalls === "number" && Number.isFinite(originalMaxToolCalls)
        ? originalMaxToolCalls
        : undefined
    const effectiveMaxToolCalls = existingMax === undefined ? policyMax : Math.min(existingMax, policyMax)
    options.maxToolCalls = effectiveMaxToolCalls
    options.parallelToolCalls = originalParallelToolCalls === false ? false : effectiveMaxToolCalls > 1
    debugCheckpoint("llm.tool_call_budget", "Tool-call budget applied", {
      sessionID: input.sessionID,
      providerId: input.model.providerId,
      modelID: input.model.id,
      status,
      ratio: input.contextBudget?.ratio,
      used: input.contextBudget?.used,
      window: input.contextBudget?.window,
      source: input.contextBudget?.source ?? "unavailable",
      policyMax,
      originalMaxToolCalls,
      effectiveMaxToolCalls,
      originalParallelToolCalls,
      effectiveParallelToolCalls: options.parallelToolCalls,
      reason: existingMax === undefined ? "defined-by-tweaks-policy" : "clamped-by-tweaks-policy",
      trace: input.sessionID,
    })
  }

  function buildEnablementSnapshot(messages: ModelMessage[], presentSkills: Set<string>): string {
    const data = ENABLEMENT as any
    const coreTools = (data?.tools?.core ?? []).map((x: any) => x.name).slice(0, 12)
    const skills = (data?.skills?.bundled_templates ?? []).slice(0, 20)
    const mcpServers = (data?.mcp_servers?.runtime_observed ?? []).map(
      (x: any) => `${x.name}:${x.enabled ? "on" : "off"}`,
    )
    const matchedRoutes = getMatchedRoutes(messages)

    const lines = [
      "[ENABLEMENT SNAPSHOT]",
      `- source: prompts/enablement.json`,
      `- core tools: ${coreTools.join(", ")}`,
      `- skills available: ${skills.join(", ")}`,
      `- configured mcp: ${mcpServers.join(", ")}`,
      `- policy: prefer registry-guided tool/skill/mcp routing; use on-demand mcp when needed`,
    ]
    if (matchedRoutes.length) {
      lines.push(`- matched routing:`)
      for (const r of matchedRoutes) {
        // Gate #1: once the companion skill is already loaded, compress the
        // route to a one-line reminder and drop the discipline-notes wall — the
        // model already has those instructions in the loaded skill's content.
        if (isRouteSatisfied(r, presentSkills)) {
          lines.push(`  * ${r.intent} → already loaded (${r.skillRefs.join(", ")}); stay on toolchain — routing notes suppressed`)
          continue
        }
        lines.push(`  * ${r.intent} → use tool_loader to load: [${r.prefer.join(", ")}]`)
        for (const note of r.notes) lines.push(`    - ${note}`)
      }
    }
    return lines.join("\n")
  }

  export async function stream(input: StreamInput) {
    debugCheckpoint("llm", "LLM.stream started", {
      modelID: input.model.id,
      providerId: input.model.providerId,
      apiNpm: input.model.api.npm,
      apiId: input.model.api.id,
      sessionID: input.sessionID,
      agent: input.agent.name,
      small: input.small ?? false,
      trace: input.sessionID,
    })

    const l = log
      .clone()
      .tag("providerId", input.model.providerId)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerId: input.model.providerId,
    })
    // Get account ID for rate limit tracking and provider options.
    // Session-scoped work MUST use the session-pinned account; global
    // activeAccount is for UI defaults / new-session init, not a silent
    // fallback for in-flight requests (RCA 2026-05-18: removing
    // activeAccount caused empty-response compaction loop because
    // multiple code paths fell through to Account.getActive).
    const sessionPinnedAccountId = input.accountId ?? input.user.model?.accountId
    let currentAccountId = sessionPinnedAccountId

    // Pre-flight: if session-pinned account is rate-limited, select a
    // healthy account from the SAME provider's account pool — never
    // fall back to global activeAccount.
    if (currentAccountId) {
      const { getRateLimitTracker, getHealthTracker } = await import("@/account/rotation")
      const rateLimitTracker = getRateLimitTracker()
      if (rateLimitTracker.isRateLimited(currentAccountId, input.model.providerId, input.model.id)) {
        const { Account } = await import("@/account")
        const providerKey = input.model.providerId
        const accounts = await Account.list(providerKey).catch(() => ({}))
        const healthTracker = getHealthTracker()
        // Find first healthy, non-rate-limited account for same provider
        let bestAccountId: string | undefined
        let bestScore = -1
        for (const [accId] of Object.entries(accounts)) {
          if (accId === currentAccountId) continue
          if (rateLimitTracker.isRateLimited(accId, providerKey, input.model.id)) continue
          const score = healthTracker.getScore(accId, providerKey)
          if (score < 50) continue
          if (score > bestScore) {
            bestScore = score
            bestAccountId = accId
          }
        }
        if (bestAccountId) {
          l.info("pre-flight: swapped rate-limited account", {
            from: currentAccountId,
            to: bestAccountId,
            providerId: providerKey,
            modelID: input.model.id,
          })
          currentAccountId = bestAccountId
        }
      }
    }

    if (!input.accountId && currentAccountId) {
      input.accountId = currentAccountId
    }
    // CHECKPOINT: ivon0829 tracker
    if (currentAccountId && currentAccountId.includes("ivon0829")) {
      debugCheckpoint("syslog.ivon0829", "⚠ ivon0829 resolved in LLM.stream", {
        sessionID: input.sessionID,
        providerId: input.model.providerId,
        modelID: input.model.id,
        accountId: currentAccountId,
        source: "session-pinned",
        inputAccountId: input.accountId,
        userMessageAccountId: input.user.model?.accountId,
      })
    }
    logSessionAccountAudit({
      requestPhase: "llm-start",
      sessionID: input.sessionID,
      userMessageID: input.user.id,
      providerId: input.model.providerId,
      modelID: input.model.id,
      accountId: currentAccountId,
      source: resolveAccountAuditSource({
        explicitAccountId: input.accountId,
        userMessageAccountId: input.user.model?.accountId,
        resolvedAccountId: currentAccountId,
      }),
      note: "llm stream starting with resolved execution identity",
    })

    const executionModel = await Provider.resolveExecutionModel({
      model: input.model,
      accountId: currentAccountId,
    })

    const [language, cfg, provider, auth] = await Promise.all([
      // @spec specs/provider-account-decoupling DD-3 — getLanguage carries
      // the accountId explicitly so getSDK merges per-account auth/options
      // for THIS specific account, not just the family's active.
      Provider.getLanguage(executionModel, currentAccountId ?? undefined),
      Config.get(),
      Provider.getProvider(executionModel.providerId),
      // @spec specs/provider-account-decoupling DD-2 — dispatch carries account
      // identity explicitly. currentAccountId is the session-pinned account
      // (see preflight identity resolution earlier in this function).
      Auth.get(executionModel.providerId, currentAccountId ?? undefined),
    ])
    const billingMode = resolveProviderBillingMode(cfg, executionModel.providerId)
    // Resolve effective prompt-injection mode for this provider.
    // New: `mode: "full" | "lite" | "freerun"`. Legacy: `lite: true` → "lite".
    // freerun-mode treats prompt injection as lite-equivalent (no skill injection,
    // no heavy system prompt) because per-iteration ContextNode rendering replaces them.
    // compaction_enrichment-ai-first DD-9/DD-10: the freerun verdict comes from the
    // shared FreerunResolver (provider tag OR contextLimit ≤ 128K, respecting the
    // per-session override) so this site can never desync from the compaction
    // bypass or the bash privileged-command block.
    const providerCfg = (
      cfg.provider as Record<string, { lite?: boolean; mode?: "full" | "lite" | "freerun" }> | undefined
    )?.[executionModel.providerId]
    const { FreerunResolver } = await import("./freerun-resolver")
    const isFreerunResolved = await FreerunResolver.isFreerunSession(input.sessionID, {
      providerId: executionModel.providerId,
      modelID: executionModel.id,
      limit: { context: executionModel.limit?.context },
    })
    const effectiveMode: "full" | "lite" | "freerun" = isFreerunResolved
      ? "freerun"
      : ((providerCfg?.mode === "freerun" ? "full" : providerCfg?.mode) ??
        (providerCfg?.lite === true ? "lite" : "full"))
    // Phase 0 decision: freerun is an INERT flag until the engine (Phase 1) is built.
    // Engine will override prompt/tool/loop assembly in its own path. Pre-engine,
    // freerun-mode sessions must behave identically to full-mode (keep skills,
    // tools, full system prompt). Only `lite` strips capabilities deliberately.
    const isLiteProvider = effectiveMode === "lite"
    const skillLayerEntries = isLiteProvider
      ? []
      : SkillLayerRegistry.listForInjection(input.sessionID, {
          latestUserText: extractLatestUserText(input.messages),
        })

    debugCheckpoint("llm", "Provider and auth loaded", {
      providerId: input.model.providerId,
      executionProviderId: executionModel.providerId,
      billingMode,
      providerSource: provider?.source,
      hasCustomFetch: typeof provider?.options?.fetch === "function",
      accountId: currentAccountId,
      authType: auth?.type,
      providerOptionsKeys: provider?.options ? Object.keys(provider.options) : [],
      trace: input.sessionID,
    })

    // Get provider capabilities (centralizes provider-specific behavior)
    const capabilities = getCapabilities(provider, auth)

    const subagentSession = await isSubagentSession(input.sessionID)
    // @plans/provider-hotfix Phase 2 — parent session id feeds the
    // x-codex-parent-thread-id header on codex Responses API calls.
    const parentSessionID = subagentSession ? await resolveParentSessionID(input.sessionID) : undefined
    // Skills already present in context this turn — computed AFTER
    // listForInjection (above) so runtimeState is fresh. Drives the state-aware
    // routing nudge (gate #1): a route is suppressed/compressed once its
    // companion skill is loaded.
    const presentSkills = SkillLayerRegistry.presentSkillNames(input.sessionID)
    // Gate-A keep-alive on the ground-truth signal: a skill stays resident
    // because its toolchain is being actively invoked (what the model DID), not
    // because the user's text contained a keyword (what the user SAID). This
    // prevents the idle clock from unloading an in-use skill mid-task without
    // reintroducing the brittle keyword heuristic that caused the original bug.
    keepAliveSkillsByToolUse(input.sessionID, input.messages, Date.now())
    const injectEnablementSnapshot = shouldInjectEnablementSnapshot(input.messages, presentSkills)
    const system: string[] = []
    let preface: ContextPrefaceMessageOutput | undefined
    // DD-22 Part B: T1 (low-freq per-session context) is hoisted out of the tail
    // preface and carried here so it can be routed into a cached SYSTEM block via
    // requestProviderOptions (claude-cli) instead of being re-sent full-price in
    // the uncached tail every turn. Native claude path only; codex is unaffected.
    let lowFreqContextText: string | undefined
    // plans/provider_codex-prompt-realign Stage A.3-2: hoisted so the
    // bundle-injection block (after the preface insertion below) can read
    // the same flag and the same driver hash that buildStaticBlock produced.
    let useUpstreamWire = false
    let driverHashForLog = ""
    let driverCharsForLog = 0
    // Bundle outputs hoisted for the prompt-telemetry block below so the
    // sidebar `Prompt blocks` panel can render bundle entries on the new
    // wire path (legacy path still gets preface.contentBlocks).
    let developerBundleForTelemetry: { parts: string[]; fragmentIds: string[] } | null = null
    let userBundleForTelemetry: { parts: string[]; fragmentIds: string[] } | null = null

    if (isLiteProvider) {
      // Lite provider (DD-14): single concise system prompt, no static-block
      // refactor, no preface. Lite mode optimizes for token economy.
      const liteText = [
        "You are a helpful assistant. Be concise and direct.",
        "Reply in the same language the user uses.",
        input.user.system ?? "",
      ]
        .filter(Boolean)
        .join("\n")
      system.push(liteText)
      // Cache-miss diagnostic still tracks lite hash for completeness.
      recordSystemBlockHash(input.sessionID, liteText)
    } else {
      // Phase B (DD-12 + DD-15 + DD-16): assemble the seven static layers
      // through the StaticSystemBuilder pipeline.
      const knownFamilies = await Account.knownFamilies()
      const family = resolveFamily(executionModel.providerId, knownFamilies)

      // L1 driver + L7 SYSTEM.md must remain in the static system block. The
      // codex provider's convertPrompt hard-codes the Responses-API
      // `instructions` field to a 28-byte placeholder (see
      // packages/provider-codex/src/convert.ts) and ignores
      // options.instructions; the real system prompt reaches codex by going
      // through the LMv2 system-role message → developer-role input item.
      // Zeroing these layers here would silently strip the persona + global
      // rules from every codex turn (RCA 2026-05-08, ses_1f8628ed...).
      const driverText = (await SystemPrompt.provider(input.model)).join("\n")
      const agentText = input.agent.prompt ?? ""
      // Subagents skip AGENTS.md (matches pre-Phase-B prompt.ts L2151
      // `session.parentID ? [] : instructionPrompts`). Caller threads the
      // agentsMd field; we just gate it here on subagent-ness.
      const agentsMdText = subagentSession ? "" : (input.agentsMd ?? "")
      const userSystemText = input.user.system ?? ""
      const systemMdText = (await SystemPrompt.system(subagentSession)).join("\n")
      const identityText =
        `\n\n[IDENTITY REINFORCEMENT]\n` +
        `Current Role: ${subagentSession ? "Subagent" : "Main Agent"}\n` +
        `Session Context: ${subagentSession ? "Sub-task" : "Main-task Orchestration"}`

      // bare/passthrough session (plans/bare_chat_session DD-1/DD-2): when the
      // reserved `bare` agent is active, the ONLY system layer is the caller's
      // userSystem. driver / agent / AGENTS.md / SYSTEM.md / identity are all
      // zeroed so an external same-host caller (e.g. cecelearn) gets a clean
      // conversation with no opencode persona contamination. This is the mirror
      // of the codex driverOnlyBlock below (which keeps only `driver`).
      // Strictly gated on agentName === "bare" so every normal session keeps the
      // full 7-layer assembly byte-identical (R1).
      const isBareSession = input.agent.name === "bare"
      const tuple: StaticSystemTuple = {
        family,
        accountId: currentAccountId ?? undefined,
        modelId: input.model.id,
        agentName: input.agent.name,
        role: subagentSession ? "subagent" : "main",
        layers: isBareSession
          ? {
              driver: "",
              agent: "",
              agentsMd: "",
              userSystem: userSystemText,
              systemMd: "",
              identity: "",
            }
          : {
              driver: driverText,
              agent: agentText,
              agentsMd: agentsMdText,
              userSystem: userSystemText,
              systemMd: systemMdText,
              identity: identityText,
            },
      }
      const staticBlock = buildStaticBlock(tuple)

      // DD-8 fail-fast (天條 #11) — POST-condition, not pre-condition. The
      // ambient driver/agentsMd/systemMd/identity layers are ALWAYS populated
      // for a primary session; zeroing them in the bare tuple above IS the
      // feature, so checking their source values false-positives on every bare
      // turn (the repo's AGENTS.md is ~29KB). Instead verify the ASSEMBLED bare
      // block did not leak a persona layer: the identity sentinel must be
      // absent. This guards a future buildStaticBlock refactor silently
      // re-introducing layers (R1/R5) without tripping on ambient inputs, and
      // can't false-positive (a caller's userSystem won't contain the sentinel).
      if (isBareSession && staticBlock.text.includes("[IDENTITY REINFORCEMENT]")) {
        throw new Error(
          `BARE_LAYER_INJECTION_VIOLATION: bare assembled system leaked a non-userSystem ` +
            `layer (identity sentinel present) — layer-zeroing regressed`,
        )
      }

      // plans/provider_codex-prompt-realign Stage A.3-2: codex provider
      // takes the upstream-aligned wire layout — `instructions` carries
      // BaseInstructions (driver) only; agent / agentsMd / userSystem /
      // systemMd / identity are emitted as developer/user fragment bundles
      // in `input[]` (see fragment block below). Feature-flagged so a
      // single env var rolls back to the legacy monolithic-system path.
      useUpstreamWire =
        (input.model.providerId === "codex" || input.model.providerId.startsWith("codex")) &&
        process.env["OPENCODE_CODEX_LEGACY_INSTRUCTIONS"] !== "1"

      // Gemini-specific behavioral_guidelines optimization (preserved from
      // pre-Phase-B). Operates on the assembled static block text. The
      // surgery only matches the AGENTS.md region; if anything moves around
      // due to Phase B layer reordering this no-ops gracefully.
      let staticText = staticBlock.text
      if (useUpstreamWire) {
        // Override system[0] to driver-only. Other layers move into fragments
        // (built after Plugin.trigger below). Preserves the staticBlock hash
        // calculation upstream — only the system_block_0 byte payload changes.
        const driverOnlyBlock = buildStaticBlock({
          ...tuple,
          layers: {
            driver: tuple.layers.driver,
            agent: "",
            agentsMd: "",
            userSystem: "",
            systemMd: "",
            identity: "",
          },
        })
        staticText = driverOnlyBlock.text
        driverHashForLog = driverOnlyBlock.hash.slice(0, 12)
        driverCharsForLog = staticText.length
      }
      const modelId = input.model?.id?.toLowerCase() || ""
      if (modelId.includes("gemini") && staticText) {
        const agentsBlockRegex = /Instructions from: .*?AGENTS\.md[\s\S]*?(?=\nInstructions from:|<env>|$)/g
        const matches = staticText.match(agentsBlockRegex)
        if (matches && matches.length > 0) {
          const agentsContent = matches.join("\n\n").trim()
          let stripped = staticText.replace(agentsBlockRegex, "").trim()
          const headerRegex = /^(IMPORTANT:[\s\S]*?)(?=\n# |$)/
          const headerMatch = stripped.match(headerRegex)
          let headerLine = ""
          if (headerMatch) {
            headerLine = headerMatch[1].trim()
            stripped = stripped.replace(headerMatch[0], "").trim()
          }
          const optimizedAgents = `<behavioral_guidelines>\n${agentsContent}\n</behavioral_guidelines>`
          staticText = [headerLine, optimizedAgents, stripped].filter(Boolean).join("\n\n")
        }
      }

      system.push(staticText)

      // Freerun mode addendum — concatenated INTO the existing system[0]
      // (not pushed as a separate system message). Many model chat
      // templates (notably llama.cpp's strict Jinja for Qwen3.6) raise
      // "System message must be at the beginning" if there are multiple
      // system entries. Single-system invariant respected by joining.
      if (effectiveMode === "freerun") {
        try {
          const freerunMd = await loadFreerunMd()
          if (freerunMd && system.length > 0) {
            system[0] = system[0] + "\n\n---\n\n" + freerunMd
          } else if (freerunMd) {
            system.push(freerunMd)
          }
        } catch {
          // Loading failure is non-fatal — freerun toggle still works
          // (task strip + sudo gate + compaction bypass) without the
          // prompt addendum.
        }
      }

      // Plugin transform on the static-only system array (DD-11).
      const original = clone(system)
      await Plugin.trigger(
        "experimental.chat.system.transform",
        { sessionID: input.sessionID, model: input.model },
        { system },
      )
      if (system.length === 0) {
        system.push(...original)
      }

      // DD-10 (Phase B amended): record the static-block hash, NOT the
      // full system.join. Phase A's `system.join("\n")` was a placeholder;
      // now that the static portion is byte-isolated we feed the sharper
      // signal so cache_miss_diagnosis can distinguish system-prefix-churn
      // from conversation growth without dynamic noise.
      recordSystemBlockHash(input.sessionID, staticBlock.hash)

      if (!useUpstreamWire) {
        // Phase B (DD-1, DD-2, DD-4, DD-5): build the user-role context preface
        // with T1 (preload + pinned skills + date) and T2 (active + summarized
        // skills) ranked slow-first. Per-turn extras (input.system carry-over
        // for lazy catalog / structured output / notices / quota-low addenda)
        // ride the trailing tier.
        //
        // plans/provider_codex-prompt-realign Stage A.3-2: codex provider
        // takes the upstream-aligned wire (driver-only instructions + fragment
        // bundles in input[]); preface is skipped on that path. The fragment
        // assembly + bundle injection runs after this block.
        const enablementText = injectEnablementSnapshot ? buildEnablementSnapshot(input.messages, presentSkills) : ""
        const partitioned = SkillLayerRegistry.partitionForPreface(skillLayerEntries)

        // attachment-lifecycle v4/v5 (DD-19/DD-20/DD-22): assemble
        //   1. activeImageBlocks — actual image binary for the AI to view
        //      this turn (only filenames in activeImageRefs, populated by
        //      reread_attachment voucher calls — v5 no longer auto-adds on
        //      upload).
        //   2. inventory text — `<attached_images>` block listing every
        //      session-attached image so the AI knows what's available
        //      and can call reread_attachment for the ones it needs.
        // Both ride the trailing tier (BP4 zone) so per-turn churn never
        // invalidates T1/T2 prefix.
        let activeImageBlocks: InlineImageContentBlock[] = []
        let inventoryText = ""
        const inlineCfg = Tweaks.attachmentInlineSync()
        if (inlineCfg.enabled) {
          try {
            const { Session: SessionMod } = await import("@/session")
            const { buildAttachedImagesInventory } = await import("./attached-images-inventory")
            const sessionInfo = await SessionMod.get(input.sessionID).catch(() => undefined)
            const refs = sessionInfo?.execution?.activeImageRefs ?? []
            const messagesV2 = await SessionMod.messages({ sessionID: input.sessionID }).catch(() => [])

            // v5 inventory: built from ALL image attachment_refs, regardless
            // of whether they're in the active set this turn. Empty when 0
            // images so caller can omit cleanly.
            inventoryText = buildAttachedImagesInventory(messagesV2, { activeImageRefs: refs })

            if (refs.length > 0) {
              const { IncomingPaths } = await import("@/incoming/paths")
              const { SessionIncomingPaths } = await import("@/incoming/session-paths")
              const pathMod = await import("node:path")
              let projectRoot = ""
              try {
                projectRoot = IncomingPaths.projectRoot()
              } catch {
                projectRoot = ""
              }
              const refsByFilename = new Map<string, InlineImageRefInput>()
              for (const m of messagesV2) {
                for (const part of m.parts ?? []) {
                  if (part.type !== "attachment_ref") continue
                  if (!part.filename || !part.mime?.startsWith("image/")) continue
                  // Hotfix: prefer session_path over repo_path for new image
                  // attachments. Old image refs (pre-hotfix) keep working via
                  // repo_path fallback.
                  let absPath = ""
                  if (part.session_path) {
                    try {
                      absPath = SessionIncomingPaths.resolveAbsolute(input.sessionID, part.session_path)
                    } catch {
                      absPath = ""
                    }
                  } else if (part.repo_path && projectRoot) {
                    absPath = pathMod.join(projectRoot, part.repo_path)
                  }
                  if (!absPath) continue
                  refsByFilename.set(part.filename, {
                    filename: part.filename,
                    mime: part.mime,
                    absPath,
                  })
                }
              }
              if (refsByFilename.size > 0) {
                activeImageBlocks = await buildActiveImageContentBlocks(refs, refsByFilename)
              }
            }
            // attachment-lifecycle v7 (BR stale-attachment-persists /
            // tool-output-redirection parity): consume-on-use. The pixels have
            // now been emitted into THIS turn's preface — the "active turn",
            // where the model sees what it just requested. Drain the active set
            // so the NEXT turn carries only the lightweight handle (the
            // <attached_images> inventory line + the model's own first-pass
            // description, already in history), never the full body again. This
            // is exactly the redirection invariant tool results already obey
            // (spec session/tool-output-redirection DD-3: active turn inline,
            // past turns → preview + handle). Re-examining pixels is an explicit
            // reread_attachment fetch, not an every-turn re-send.
            //
            // Drained AFTER the preface consumed the voucher (the post-emit site
            // commit 78a8e1b3c proved correct — draining at processor
            // step-finish wiped the voucher BEFORE emit and looped). Drain
            // whenever refs were present so a missing-file emit also clears the
            // voucher rather than retrying forever. v6 (416b775f3) removed this
            // drain in favour of persist-across-turns; that persistence is what
            // re-injected stale screenshots every turn and caused the 跳針 loop.
            if (refs.length > 0) {
              await SessionMod.setActiveImageRefs(input.sessionID, []).catch((err) => {
                l.warn("activeImageRefs drain after preface emit failed", {
                  error: err instanceof Error ? err.message : String(err),
                })
              })
            }
          } catch (err) {
            l.warn("active image inline failed; preface continues without images", {
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        const prefaceInput = {
          preload: input.preload ?? { readmeSummary: "", cwdListing: "" },
          skills: {
            pinned: partitioned.pinned,
            active: partitioned.active,
            summarized: partitioned.summarized,
          },
          todaysDate: input.todaysDate ?? new Date().toDateString(),
          trailingExtras: [
            ...input.system.filter(Boolean),
            ...(enablementText ? [enablementText] : []),
            // v5: inventory comes LAST in text trailing extras so it sits
            // immediately before the actual image blocks (also trailing tier).
            // AI reads "what's available" → sees pixels → uses both signals.
            ...(inventoryText ? [inventoryText] : []),
          ],
          activeImageBlocks,
        }

        // DD-11: experimental.chat.context.transform hook. Plugins can mutate
        // preface fields (preload / skills / date / trailingExtras) before
        // buildPreface serializes them. This is the new hook for Phase B
        // dynamic content, complementing experimental.chat.system.transform
        // which now receives only the static block.
        const contextTransformOutput = {
          preface: {
            t1: {
              readmeSummary: prefaceInput.preload.readmeSummary,
              cwdListing: prefaceInput.preload.cwdListing,
              pinnedSkills: prefaceInput.skills.pinned,
              todaysDate: prefaceInput.todaysDate,
            },
            t2: {
              activeSkills: prefaceInput.skills.active,
              summarizedSkills: prefaceInput.skills.summarized,
            },
          },
          trailingExtras: prefaceInput.trailingExtras,
        }
        await Plugin.trigger(
          "experimental.chat.context.transform",
          { sessionID: input.sessionID, model: input.model },
          contextTransformOutput,
        )
        // Reconstruct prefaceInput from possibly-mutated hook output.
        preface = buildPreface({
          preload: {
            readmeSummary: contextTransformOutput.preface.t1.readmeSummary,
            cwdListing: contextTransformOutput.preface.t1.cwdListing,
          },
          skills: {
            pinned: contextTransformOutput.preface.t1.pinnedSkills,
            active: contextTransformOutput.preface.t2.activeSkills,
            summarized: contextTransformOutput.preface.t2.summarizedSkills,
          },
          todaysDate: contextTransformOutput.preface.t1.todaysDate,
          trailingExtras: contextTransformOutput.trailingExtras,
          activeImageBlocks: prefaceInput.activeImageBlocks,
        })

        // DD-13 (assembly-time telemetry): emit the breakpoint plan so we can
        // observe the static-vs-dynamic split per turn. Cache hit/miss
        // telemetry from provider response headers is deferred — the existing
        // cachedInputTokens in usage stats already covers that signal at a
        // coarser granularity.
        const t1Block = preface.contentBlocks.find((b) => b.type === "text" && b.tier === "t1")
        const t2Block = preface.contentBlocks.find((b) => b.type === "text" && b.tier === "t2")
        const trailingTextBlock = preface.contentBlocks.find((b) => b.type === "text" && b.tier === "trailing")
        const inlineImageCount = preface.contentBlocks.filter((b) => b.type === "file").length
        log.info("prompt.preface.assembled", {
          sessionID: input.sessionID,
          staticBlockChars: staticBlock.text.length,
          staticBlockHash: staticBlock.hash.slice(0, 12),
          t1Chars: t1Block && t1Block.type === "text" ? t1Block.text.length : 0,
          t2Chars: t2Block && t2Block.type === "text" ? t2Block.text.length : 0,
          trailingChars: trailingTextBlock && trailingTextBlock.type === "text" ? trailingTextBlock.text.length : 0,
          inlineImageCount,
          t2Empty: preface.t2Empty,
          breakpointPlan: {
            // DD-22 Part B: T1 now caches as a SYSTEM block (before the
            // conversation), not a tail-preface breakpoint. T2/trailing ride the
            // uncached tail. System = systemText + T1 (2); conversation = 2.
            BP1: "system-static-end (identity rides systemText)",
            BP2: t1Block ? "system-t1-end (DD-22B cached)" : "omitted",
            BP3: "conversation-prev",
            BP4: "conversation-final",
          },
        })
      }
    } // end of if (!useUpstreamWire) — preface buildup

    // Splice the preface message into the outbound messages list. DD-1 says
    // "before the user's first real text turn"; with multi-turn streaming
    // the most recent user turn is the relevant insertion point — putting
    // the preface immediately before THAT user message keeps it adjacent so
    // the LLM reads it as context for the upcoming reply. The preface is
    // ephemeral (rebuilt per call); not persisted to storage.
    if (preface) {
      // DD-18: the LAST user-role turn — role "user" OR a tool result (tool
      // results are user-role on the Anthropic wire). The preface is appended
      // AFTER this index so it rides the uncached TAIL, mirroring official
      // claude-code (Y35/w append the api_system reminder after the user turn).
      // Inserting BEFORE it (the old behaviour) put the volatile preface inside
      // the cached prefix → conversation cold-rewrite on every preface change.
      // See plans/provider-claude_conversation-cache-breakpoint/datasheet.md.
      const lastUserTurnIdx = (() => {
        for (let i = input.messages.length - 1; i >= 0; i--) {
          const r = input.messages[i]?.role
          if (r === "user" || r === "tool") return i
        }
        return -1
      })()
      // DD-3 + B.5 wiring: tag T1-end and T2-end content blocks with the
      // ProviderTransform PHASE_B_BREAKPOINT_PROVIDER_OPTION marker so
      // applyCaching places explicit BP2/BP3 there. The trailing tier is
      // deliberately NOT marked — it rides BP4 via the following user msg.
      // DD-22 Part B: hoist T1 (low-freq) OUT of the tail preface. Its text is
      // routed to a cached SYSTEM block (lowFreqContextText → providerOptions →
      // convertSystemBlocks), placed before the conversation so it caches across
      // turns instead of being re-sent full-price in the uncached tail. T2 +
      // trailing + images stay in the tail. T1 goes UNFRAMED (a system block is
      // already system context; the <system-reminder> framing in Part A is for
      // the message-stream tail, not the system region).
      const allBlocks = preface.contentBlocks
      const t1Texts: string[] = []
      for (const b of allBlocks) if (b.type === "text" && b.tier === "t1") t1Texts.push(b.text)
      lowFreqContextText = t1Texts.length ? t1Texts.join("\n\n") : undefined
      const blocks = allBlocks.filter((b) => !(b.type === "text" && b.tier === "t1"))
      const t2LastIdx = (() => {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]
          if (b?.type === "text" && b.tier === "t2") return i
        }
        return -1
      })()
      // Two-level nested namespace required by AI SDK's
      // providerMetadataSchema (Record<string, Record<string, JsonValue>>).
      // Flat boolean at the outer level fails validation with
      // "messages must be a ModelMessage[]".
      // Block-level context-preface marker. The native claude convert path reads
      // this off content blocks (message-level providerOptions do NOT survive the
      // pipeline — the message-level marker below was inert) to skip the preface
      // when placing conversation cache breakpoints. anthropic.contextPreface on
      // text blocks rides the same inbound channel as anthropic.signature.
      const PREFACE_BLOCK_MARKER = { anthropic: { contextPreface: true } } as const
      const prefaceContent = blocks.map((b, i) => {
        if (b.type === "file") {
          // v4 DD-19: image binary block — passes through to AI SDK as-is.
          // Never gets a Phase B breakpoint marker; rides BP4 with the
          // following user message (per-turn churn zone).
          return {
            type: "file" as const,
            data: b.url,
            mediaType: b.mediaType,
            filename: b.filename,
          }
        }
        const needsBreakpoint = i === t2LastIdx
        return {
          type: "text" as const,
          // DD-22 Part A: frame each preface tier as a <system-reminder> so the
          // model reads the tail as per-turn SYSTEM context, not a second user
          // utterance. Mirrors official u2()/Y35() (the tail is role api_system /
          // system-framed). Cache-neutral — the preface rides the uncached tail.
          text: `<system-reminder>\n${b.text}\n</system-reminder>`,
          providerOptions: {
            ...(needsBreakpoint ? ProviderTransform.PHASE_B_BREAKPOINT_PROVIDER_OPTION : {}),
            ...PREFACE_BLOCK_MARKER,
          },
        }
      })
      // Mark as the injected context preface so the native claude breakpoint
      // finder (applyConversationCacheBreakpoint) skips it. DD-18: place it in the
      // uncached TAIL — AFTER the last user-role turn — so the entire real
      // conversation stays a clean, append-only cached prefix and a preface change
      // only re-writes the tail. Mirrors official Y35/w (api_system after the user
      // turn) + TF5 (breakpoint on the last real message, skipping trailing
      // context). RCA + structure: issues/bug_20260602_claude_cli_rapid_narrative_compaction_cascade §12
      // and plans/provider-claude_conversation-cache-breakpoint/datasheet.md.
      const prefaceMessage: ModelMessage = {
        role: "user",
        content: prefaceContent,
        providerOptions: { anthropic: { contextPreface: true } },
      }
      const insertAt = lastUserTurnIdx >= 0 ? lastUserTurnIdx + 1 : input.messages.length
      input.messages = [...input.messages.slice(0, insertAt), prefaceMessage, ...input.messages.slice(insertAt)]
    }

    // plans/provider_codex-prompt-realign Stage A.3-2: upstream-aligned
    // wire — assemble fragment list and prepend a developer-role bundle +
    // a user-role bundle as ModelMessage items in `input.messages`.
    // codex provider's convertPrompt picks up `providerOptions.codex.kind`
    // markers to emit them as Responses-API role:"developer" / role:"user"
    // ResponseItems (matches refs/codex/codex-rs/core/src/session/mod.rs
    // build_initial_context() output shape).
    if (useUpstreamWire) {
      const fragments: ContextFragment[] = []
      // Developer-role: identity → constitution → agent persona overlay.
      // RoleIdentity first so Main vs Subagent is the very first thing the
      // model sees (DD-8).
      const identitySource = (() => {
        // input.agent.name is most authoritative; fall back to subagentSession
        // detection.
        return subagentSession
      })()
      fragments.push(buildRoleIdentityFragment({ isSubagent: identitySource }))
      const systemMdJoined = (await SystemPrompt.system(subagentSession)).join("\n")
      if (systemMdJoined.trim().length > 0) {
        fragments.push(buildOpencodeProtocolFragment({ text: systemMdJoined }))
      }
      const agentPromptText = input.agent.prompt ?? ""
      const userSystemText = input.user.system ?? ""
      if ((agentPromptText.trim() + userSystemText.trim()).length > 0) {
        fragments.push(
          buildOpencodeAgentInstructionsFragment({
            agentPrompt: agentPromptText,
            userSystem: userSystemText,
          }),
        )
      }
      // User-role: AGENTS.md (global, then project) → environment context.
      // Subagents skip AGENTS.md (matches legacy subagent gate).
      if (!subagentSession) {
        const instructionPrompts = await InstructionPrompt.system(input.sessionID)
        for (const item of instructionPrompts) {
          // Items shape: "Instructions from: <abs-path>\n<content>"
          const m = item.match(/^Instructions from: (.+?)\n([\s\S]*)$/)
          if (!m) continue
          const filePath = m[1]
          const content = m[2]
          const directory = path.dirname(filePath)
          const isGlobal = directory.startsWith(Global.Path.config)
          fragments.push(
            buildUserInstructionsFragment({
              scope: isGlobal ? "global" : "project",
              directory,
              text: content,
            }),
          )
        }
      }
      const cwd = Instance.directory
      const shellName = process.platform === "win32" ? "cmd.exe" : "bash"
      const todaysDate = new Date().toDateString()
      const timezone = (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone
        } catch {
          return undefined
        }
      })()
      // compaction/recall-affordance L3: inject an amnesia notice fragment
      // when the most recent compaction event was narrative-kind. Tells the
      // model its tool history is summarized and points at TOOL_INDEX +
      // `recall` for retrieval. Re-injected each turn until a non-narrative
      // compaction supersedes the narrative one in recentEvents.
      //
      // 2026-05-12 (session/rebind-procedure-revision Phase C+): also
      // consume the once-after-chain-break PendingInjectionStore marker.
      // Two complementary cadences:
      //   - amnesia_notice  → re-injected every turn while compaction is
      //                       the latest break-class (persistent)
      //   - chain_init_notice → fires ONCE on the first outbound after
      //                         any chain-break event, then clears
      //                         (one-shot, per DD-1 sibling fragments)
      // The pending marker also carries the commitment digest captured
      // synchronously at the break (DD-8); we thread it into both
      // fragments so the AI sees "you did these mutations, don't redo"
      // regardless of which notice surfaces it.
      const pendingInjection = await (async () => {
        try {
          const { PendingInjectionStore } = await import("./continuation/pending-injection")
          return PendingInjectionStore.consume(input.sessionID)
        } catch (err) {
          log.warn("chain_init_notice.consume_failed", {
            sessionID: input.sessionID,
            error: err instanceof Error ? err.message : String(err),
          })
          return null
        }
      })()

      try {
        const sessionInfo = await Session.get(input.sessionID).catch(() => undefined)
        const decision = decideAmnesiaInjection(sessionInfo?.execution?.recentEvents)
        if (decision.inject) {
          fragments.push(
            buildAmnesiaNoticeFragment({
              anchorKind: decision.anchorKind,
              digest: pendingInjection?.amnesia ? pendingInjection.digest : undefined,
            }),
          )
          log.info("prompt.amnesia_notice.injected", {
            sessionID: input.sessionID,
            anchorKind: decision.anchorKind,
            ts: decision.ts,
            digestEntryCount: pendingInjection?.digest?.entries.length ?? 0,
          })
        }
      } catch (err) {
        log.warn("amnesia_notice.check_failed", {
          sessionID: input.sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // chain-init notice (session/rebind-procedure-revision M4):
      // one-shot fragment fired on the outbound immediately following a
      // chain-identity-breaking event (account_switch, rotation,
      // empty-response recovery, …). Tells the AI its server-side
      // reasoning chain was reset; carries the commitment digest so the
      // model knows what's already done.
      try {
        const { decideChainInitInjection, buildChainInitNoticeFragment } =
          await import("./context-fragments/chain-init-notice")
        const chainInitMark = decideChainInitInjection(pendingInjection)
        if (chainInitMark) {
          fragments.push(
            buildChainInitNoticeFragment({
              reason: chainInitMark.reason,
              digest: chainInitMark.digest,
              anchorId: chainInitMark.anchorId,
            }),
          )
          log.info("prompt.chain_init_notice.injected", {
            sessionID: input.sessionID,
            reason: chainInitMark.reason,
            digestEntryCount: chainInitMark.digest?.entries.length ?? 0,
          })
        }
      } catch (err) {
        log.warn("chain_init_notice.check_failed", {
          sessionID: input.sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      fragments.push(
        buildEnvironmentContextFragment({
          cwd,
          shell: shellName,
          currentDate: todaysDate,
          timezone,
        }),
      )

      const { developerBundle, userBundle } = assembleBundles(fragments)
      developerBundleForTelemetry = developerBundle
      userBundleForTelemetry = userBundle
      const bundleMessages: ModelMessage[] = []
      if (developerBundle) {
        // Emit one text part per fragment to match upstream codex-rs
        // `build_text_message` (refs/codex/codex-rs/core/src/context_manager/
        // updates.rs:178) — `Vec<ContentItem::InputText>`, one per section.
        // Pre-fix we joined fragments into a single text part, which produced
        // an `Array<ContentItem>` of length 1 and diverged from upstream
        // whenever N≥2 fragments coexisted; server prefix-cache keys on the
        // content[] cardinality and the chain got stuck at the ~4608 floor
        // (RCA: plans/provider_codex-prompt-realign/events/event_2026-05-11_
        // rca-content-parts-shape-divergence-subagent-vs-main.md).
        bundleMessages.push({
          role: "user",
          content: developerBundle.parts.map((text) => ({ type: "text", text })),
          providerOptions: { codex: { kind: "developer-bundle" } },
        })
      }
      if (userBundle) {
        bundleMessages.push({
          role: "user",
          content: userBundle.parts.map((text) => ({ type: "text", text })),
          providerOptions: { codex: { kind: "user-bundle" } },
        })
      }
      if (bundleMessages.length > 0) {
        // Mirror upstream codex-cli `build_initial_context()`: bundles are
        // ALWAYS at index 0-1 of input[]. They become the head of the chain
        // on turn 1; on subsequent turns the WS transport's delta-slice
        // (based on prevLen) correctly identifies them as already-in-chain
        // and only the trailing NEW items are sent across the wire. Earlier
        // we inserted before lastUserIdx, which on turn 2+ landed bundles
        // AFTER the conversation tail — server saw duplicate bundles,
        // chain prefix structure diverged from the upstream-expected shape,
        // and prefix cache stuck at the tools-only ~4608 token floor.
        input.messages = [...bundleMessages, ...input.messages]
      }
      log.info("prompt.bundle.assembled", {
        sessionID: input.sessionID,
        driverHash: driverHashForLog,
        driverChars: driverCharsForLog,
        developerBundle: developerBundle
          ? {
              fragmentIds: developerBundle.fragmentIds,
              partCount: developerBundle.parts.length,
              totalChars: developerBundle.parts.reduce((sum, p) => sum + p.length, 0),
            }
          : null,
        userBundle: userBundle
          ? {
              fragmentIds: userBundle.fragmentIds,
              partCount: userBundle.parts.length,
              totalChars: userBundle.parts.reduce((sum, p) => sum + p.length, 0),
            }
          : null,
      })
    }

    // unused locals for backwards-compat (build/lint cleanliness — remove
    // when buildSkillLayerRegistrySystemPart and injectEnablementSnapshot
    // are fully retired in Phase B follow-ups).
    void buildSkillLayerRegistrySystemPart
    void injectEnablementSnapshot

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model, provider.options)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
          accountId: currentAccountId,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )
    applyToolCallBudget(input, params.options)

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const maxOutputTokens = capabilities.skipMaxOutputTokens
      ? undefined
      : ProviderTransform.maxOutputTokens(
          input.model.api.npm,
          params.options,
          input.model.limit.output,
          OUTPUT_TOKEN_MAX,
        )

    const tools = isLiteProvider ? {} : await resolveTools(input)

    // DD-20 (single-agent serial-only invariant): freerun mode must NEVER
    // dispatch subagents. The `task` tool is the subagent-fan-out vector;
    // strip it (and its cancellation companion) when effectiveMode is
    // freerun, regardless of whether the call originates from the freerun
    // engine's own LlmClient or from opencode's regular session path
    // (TUI / API) against a freerun-tagged provider.
    if (effectiveMode === "freerun") {
      delete tools["task"]
      delete tools["cancel_task"]
    }

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerId.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    // FIX: Filter out empty system messages to prevent Anthropic API rejection
    // Anthropic API returns 400 error: "system: text content blocks must be non-empty"
    // @event_20260209_empty_system_blocks
    const filteredSystem = system.filter((x) => x && x.trim() !== "")
    // Phase B: telemetry blocks reflect the new two-track shape (static
    // system + preface). The old per-layer breakdown is replaced by a
    // coarser block-level view; per-layer chars/tokens are derivable
    // upstream by the caller if needed.
    // Block naming convention (2026-05-09 user clarification):
    // The cache-reuse model orders prompt regions by update frequency,
    // low → high. Static system layer never changes within a session;
    // the dynamic layers below it churn progressively. Names reflect
    // that mental model so the operator can read "where prefix cache
    // hits stop".
    //   靜態系統層     — system / role / always_on (lowest churn)
    //   動態內文 · 低頻 — conversation_stable: README, cwd, pinned skills, date
    //   動態內文 · 中頻 — decay: active / summarized skills (T2)
    //   動態內文 · 高頻 — dynamic: trailing extras + per-turn images
    //
    // 2026-05-12: policy taxonomy refined per
    // plans/session_rebind-procedure-revision/ M6. The legacy label
    // "session_stable" conflated two invariants; it is now split into
    // "conversation_stable" (chain-independent — preface T1, developer
    // bundle) and "chain_stable" (chain-dependent — user bundle, which
    // can carry amnesia_notice / environment_context that legitimately
    // need to recompute when the chain identity resets).
    const promptTelemetryBlocks: Array<{
      key: string
      name: string
      chars: number
      tokens: number
      injected: boolean
      policy: string
    }> = [
      ...system.map((text, idx) => ({
        key: `system_block_${idx}`,
        name: idx === 0 ? "靜態系統層" : `靜態系統層補充 ${idx}`,
        chars: text.length,
        tokens: Token.estimate(text),
        injected: text.trim().length > 0,
        policy: "always_on",
      })),
      ...(preface
        ? preface.contentBlocks.map((b, idx) => {
            if (b.type === "file") {
              return {
                key: `preface_image_${idx}`,
                name: `動態內文 · 高頻（圖片 ${b.filename}）`,
                chars: 0,
                tokens: 0,
                injected: true,
                policy: "dynamic",
              }
            }
            const tierLabel = b.tier === "trailing" ? "高頻" : b.tier === "t2" ? "中頻" : "低頻"
            return {
              key: `preface_${b.tier}`,
              name: `動態內文 · ${tierLabel}`,
              chars: b.text.length,
              tokens: Token.estimate(b.text),
              injected: b.text.trim().length > 0,
              policy: b.tier === "trailing" ? "dynamic" : b.tier === "t2" ? "decay" : "conversation_stable",
            }
          })
        : []),
      // plans/provider_codex-prompt-realign Stage A.3-2 telemetry: surface
      // the developer / user bundles to the sidebar Prompt blocks panel.
      // Names mirror the upstream codex-cli bundle semantics.
      ...(developerBundleForTelemetry
        ? (() => {
            const joined = developerBundleForTelemetry.parts.join(FRAGMENT_SEP)
            return [
              {
                key: "bundle_developer",
                name: `開發者層 [${developerBundleForTelemetry.fragmentIds.join(", ")}]`,
                chars: joined.length,
                tokens: Token.estimate(joined),
                injected: joined.trim().length > 0,
                // role_identity + opencode_protocol — chain-independent
                policy: "conversation_stable",
              },
            ]
          })()
        : []),
      ...(userBundleForTelemetry
        ? (() => {
            const joined = userBundleForTelemetry.parts.join(FRAGMENT_SEP)
            return [
              {
                key: "bundle_user",
                name: `使用者層 [${userBundleForTelemetry.fragmentIds.join(", ")}]`,
                chars: joined.length,
                tokens: Token.estimate(joined),
                injected: joined.trim().length > 0,
                // agents_md + amnesia_notice + environment_context —
                // amnesia_notice can mutate on chain reset, so this
                // bundle is chain_stable (M6).
                policy: "chain_stable",
              },
            ]
          })()
        : []),
    ]
    const finalSystemChars = filteredSystem.reduce((sum, item) => sum + item.length, 0)
    const finalSystemTokens = filteredSystem.reduce((sum, item) => sum + Token.estimate(item), 0)
    const promptId = `prompt_${Bun.hash(
      JSON.stringify({
        sessionID: input.sessionID,
        providerId: input.model.providerId,
        modelId: input.model.id,
        accountId: currentAccountId,
        messageCount: input.messages.length,
        blocks: promptTelemetryBlocks,
        finalSystemChars,
        finalSystemTokens,
      }),
    ).toString(36)}`

    Bus.publish(PromptTelemetryEvent, {
      sessionID: input.sessionID,
      promptId,
      providerId: input.model.providerId,
      modelId: input.model.id,
      accountId: currentAccountId,
      finalSystemTokens,
      finalSystemChars,
      finalSystemMessages: filteredSystem.length,
      messageCount: input.messages.length,
      blocks: promptTelemetryBlocks,
      timestamp: Date.now(),
    }).catch(() => {})

    // Config-driven system directive injection for thinking control.
    // Models can define `defaultSystemDirective` (used when no variant is selected)
    // and per-variant `systemDirective` (used when that variant is active).
    // This allows models like Qwen3 to use prompt-level /think or /no_think directives.
    if (filteredSystem.length > 0) {
      const providerModels = (
        cfg.provider as Record<string, { models?: Record<string, { defaultSystemDirective?: string }> }> | undefined
      )?.[executionModel.providerId]?.models
      const modelConfig = providerModels?.[executionModel.id]
      const variantDirective = (variant as { systemDirective?: string })?.systemDirective
      const directive = variantDirective ?? modelConfig?.defaultSystemDirective
      log.info("systemDirective", {
        providerId: executionModel.providerId,
        modelId: executionModel.id,
        hasProviderModels: !!providerModels,
        modelConfigKeys: modelConfig ? Object.keys(modelConfig) : [],
        variantDirective,
        defaultDirective: modelConfig?.defaultSystemDirective,
        resolvedDirective: directive,
      })
      if (directive) {
        filteredSystem[0] = directive + "\n" + filteredSystem[0]
      }
    }

    const systemMessages =
      capabilities.systemMessageRole === "user"
        ? ([
            {
              role: "user",
              content: filteredSystem.join("\n\n"),
            },
          ] as ModelMessage[])
        : filteredSystem.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          )

    // Freerun stateless context regeneration:
    //   In freerun mode, dialog history is NOT accumulated for the LLM —
    //   each turn the model sees a freshly synthesized snapshot of structured
    //   state (current todos) + the latest user/directive message. UI still
    //   displays the full dialog history; only the LLM payload is stateless.
    //   This is the "context structure is no longer turn-based" invariant.
    let llmMessages: typeof input.messages = input.messages
    process.stderr.write(
      `[freerun-debug] LLM.stream effectiveMode=${effectiveMode} sessionID=${input.sessionID} inputMsgCount=${input.messages.length}\n`,
    )
    if (effectiveMode === "freerun") {
      try {
        llmMessages = await buildFreerunStatelessMessages(input.sessionID, input.messages)
        process.stderr.write(`[freerun-debug] stateless rewrite: ${input.messages.length} → ${llmMessages.length}\n`)
      } catch (err) {
        process.stderr.write(
          `[freerun-debug] stateless rewrite THREW: ${err instanceof Error ? err.message : err}\n${err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 5).join("\n") : ""}\n`,
        )
        log.warn("freerun stateless rewrite failed; falling through to full history", {
          sessionID: input.sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Paper-data sink: install per-session BusSink (idempotent) + emit
      // turn-start event so events.jsonl gets one record per opencode turn
      // in this freerun session. Sibling Bus emissions (decisions/observations/
      // etc.) come from any code path that publishes a FreerunBus.* event;
      // the sink picks them up and writes to the same events.jsonl.
      try {
        ensureFreerunSink(input.sessionID)
        const turnIdx = nextFreerunTurn(input.sessionID)
        ;(input as any).__freerunTurnIdx = turnIdx
        ;(input as any).__freerunTurnT0 = Date.now()
        await FreerunBus.emit.iterationStart({
          sessionID: input.sessionID,
          iteration: turnIdx,
          nodeID: "session-root", // runloop architecture: no node tree; session itself is the unit
          nodeMode: "pending-exec",
          depth: 0,
          pickedByPolicyReason: "runloop-turn",
        })
      } catch (err) {
        process.stderr.write(
          `[freerun-debug] paper sink install/emit THREW: ${err instanceof Error ? err.message : err}\n`,
        )
      }
    }
    const streamMessages = [...systemMessages, ...llmMessages]

    const finalMessages = normalizeMessages(streamMessages, tools)

    // Get account ID for rate limit tracking
    const accountId = currentAccountId
    const requestProviderOptions = ProviderTransform.providerOptions(input.model, params.options)
    // DD-22 Part B: hand the hoisted T1 (low-freq) text to the native claude
    // provider under its own providerId key so convertSystemBlocks can place it
    // as a cached system block. Keyed under "claude-cli" (the same channel the
    // provider already reads for thinking). No-op for other providers (codex
    // never reads this key → DD-4 byte-identical invariant holds).
    if (lowFreqContextText) {
      const opts = requestProviderOptions as Record<string, any>
      opts["claude-cli"] = { ...(opts["claude-cli"] ?? {}), lowFreqContext: lowFreqContextText }
    }
    // align-2.1.169 DD-2: hand the subagent signal to the native claude provider
    // so the billing header (HTTP + system block[0]) carries cc_is_subagent=true
    // for sub-sessions, matching the real CLI. Main sessions emit nothing →
    // billing header byte-identical, cache prefix unaffected. Only claude-cli reads
    // this key (codex ignores it → DD-4 byte-identical invariant holds).
    if (input.model.providerId === "claude-cli") {
      const isSubagent = await isSubagentSession(input.sessionID)
      const opts = requestProviderOptions as Record<string, any>
      opts["claude-cli"] = {
        ...(opts["claude-cli"] ?? {}),
        isSubagent,
        isMainSession: !isSubagent,
      }
    }
    const outboundFingerprint = Bun.hash(
      JSON.stringify({
        sessionID: input.sessionID,
        providerId: input.model.providerId,
        modelId: input.model.id,
        accountId,
        systemCount: systemMessages.length,
        messageCount: finalMessages.length,
        toolCount: Object.keys(tools).length,
        providerOptionKeys: Object.keys(requestProviderOptions ?? {}).sort(),
        messages: finalMessages.slice(0, 6).map(getMessageShapeSummary),
      }),
    ).toString(36)

    debugCheckpoint("llm.packet", "LLM outbound packet prepared", {
      sessionID: input.sessionID,
      providerId: input.model.providerId,
      modelID: input.model.id,
      accountId,
      promptId,
      outboundFingerprint,
      systemCount: systemMessages.length,
      messageCount: finalMessages.length,
      toolCount: Object.keys(tools).length,
      providerOptionKeys: Object.keys(requestProviderOptions ?? {}).sort(),
      requestProviderOptions: Array.from(collectCacheKeywords(requestProviderOptions)),
      messageShapes: finalMessages.slice(0, 6).map(getMessageShapeSummary),
      trace: input.sessionID,
    })

    const serializeError = (err: unknown): unknown => {
      if (!(err instanceof Error)) return err
      const base: Record<string, unknown> = {
        name: err.name,
        message: err.message,
        stack: err.stack,
      }
      const withCause = err as Error & { cause?: unknown; issues?: unknown }
      if (withCause.cause !== undefined) base.cause = serializeError(withCause.cause)
      if (withCause.issues !== undefined) base.issues = withCause.issues
      return base
    }

    const serializeErrorForDebug = (err: unknown): Record<string, unknown> => {
      const baseError = serializeError(err)
      const obj = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined
      const data = obj?.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : undefined
      return {
        error: baseError,
        status: obj?.status ?? obj?.statusCode ?? data?.status,
        code: obj?.code ?? data?.code,
        name: obj?.name,
        message: (() => {
          const raw = obj?.message ?? data?.message
          if (raw == null) return undefined
          return typeof raw === "string" ? raw : JSON.stringify(raw)
        })(),
        responseHeaders: data?.responseHeaders,
        responseBody: data?.responseBody,
        headers: obj?.headers ?? data?.headers,
        errorType:
          data?.error && typeof data.error === "object" ? (data.error as Record<string, unknown>).type : undefined,
        data,
      }
    }

    // Chunk-idle watchdog. The codex provider (and occasionally others) can
    // wedge a stream at 0 bytes: no tokens, no error, no close. Without a
    // watchdog the runloop awaits forever and only the client's own fetch
    // timeout surfaces it — leaving an empty assistant shell + state=running
    // that zombie-sweep can't touch because the runloop is still live.
    // Reset on every chunk so legitimate long reasoning pauses are tolerated.
    // Provider-aware: claude-opus legitimately goes silent >90s mid-stream
    // (slow prefill, and the gap between opening a tool_use and the first
    // input_json_delta of a large `write`) — it gets a wider budget. See
    // ./stream-watchdog.ts for the measured rationale (ses_18d7f02e, 2026-05-31).
    const STREAM_IDLE_TIMEOUT_MS = streamIdleTimeoutMs(input.model.providerId)
    // First-chunk watchdog. The chunk-idle timer above only re-arms on chunk
    // arrival, so "stream opened but never produced any chunk" falls through
    // to the provider-level 300_000ms AbortSignal.timeout (provider.ts:2296).
    // 6 turns in one warroom session died at ~280s on the tool-result→codex
    // continuation request (post-runloop hang investigation 2026-05-26).
    // 60_000ms is conservative for long reasoning models that may take >30s
    // before emitting their first token.
    const STREAM_FIRST_CHUNK_TIMEOUT_MS = 60_000
    const streamStartedAt = Date.now()
    let firstChunkReceived = false
    const idleController = new AbortController()
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let firstChunkTimer: ReturnType<typeof setTimeout> | undefined
    // pause flag (spec DD-1): when true, armIdleWatchdog is a no-op and any
    // pending timer is cleared. Interactive tools (question/permission) that
    // legitimately await human input flip this on for the duration of the
    // wait so the 90s wedge watchdog doesn't false-kill the stream while no
    // chunks flow. See plans/question-tool_idle-watchdog-false-kill/.
    let idleWatchdogPaused = false
    const armIdleWatchdog = () => {
      if (idleWatchdogPaused) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        l.warn("stream idle timeout — aborting", {
          sessionID: input.sessionID,
          providerId: input.model.providerId,
          modelID: input.model.id,
          accountId,
          idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        })
        idleController.abort(new Error(`stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`))
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    const disarmIdleWatchdog = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
      if (firstChunkTimer) {
        clearTimeout(firstChunkTimer)
        firstChunkTimer = undefined
      }
      // Drop the published pause function so any late-arriving tool calls
      // (e.g. straggler from a cancelled step) don't hold a reference to
      // a dead stream's watchdog. Idempotent.
      if (input.idleWatchdogBox) {
        delete input.idleWatchdogBox.pause
      }
    }
    /**
     * Interactive-tool pause hook (spec DD-1, plans/question-tool_idle-watchdog-false-kill).
     * Disarms the idle timer and flips `idleWatchdogPaused` so re-arm calls
     * (from onChunk) become no-ops. Returns an idempotent resume closure
     * that clears the pause flag and re-arms the timer. The first-chunk
     * watchdog is NOT affected (it fires before any tool runs).
     *
     * Idempotency: calling resume() twice is safe (second call is a no-op).
     * Concurrent pause is NOT ref-counted (only one interactive tool at a
     * time today — question/permission are exclusive); if multiple ever
     * become concurrent this should be revisited.
     */
    const pauseIdleWatchdog = (): (() => void) => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
      idleWatchdogPaused = true
      let resumed = false
      return () => {
        if (resumed) return
        resumed = true
        idleWatchdogPaused = false
        armIdleWatchdog()
      }
    }
    // Publish to the per-stream box so tool ctx can reach it via the
    // wrapper in resolve-tools.ts. The box is created by prompt.ts and
    // flows through ResolveToolsInput → InvokeOptions → Tool.Context.
    if (input.idleWatchdogBox) {
      input.idleWatchdogBox.pause = pauseIdleWatchdog
    }
    // The first-chunk watchdog exists ONLY for codex's documented 0-byte
    // wedge (commits b2da4beadb / 81e90fb9fb): codex post-runloop continuation
    // requests sometimes open a stream and never emit a first chunk, hanging
    // until the provider-level 300s timeout. Other providers must NOT arm it:
    // claude-opus on large prompt-cache contexts (200K+ tokens) legitimately
    // takes >60s of server-side cache-read + thinking before the first token
    // (measured 178s on a healthy, fully-answered turn), so a 60s first-chunk
    // killer false-aborts them → empty assistant turn + waiting_user
    // (the user-perceived "只說不做"). The chunk-idle watchdog re-arms on every
    // chunk and catches mid-stream wedges; it is provider-aware (see
    // STREAM_IDLE_TIMEOUT_MS above) because claude CAN go silent >90s mid-stream
    // — e.g. after opening a tool_use block, before the first input_json_delta
    // of a large `write` (observed 2026-05-31, ses_18d7f02e). The earlier claim
    // that claude "never trips" the idle watchdog was wrong.
    if (usesFirstChunkWatchdog(input.model.providerId)) {
      firstChunkTimer = setTimeout(() => {
        if (firstChunkReceived) return
        const elapsed = Date.now() - streamStartedAt
        l.warn("stream first-chunk timeout — aborting", {
          sessionID: input.sessionID,
          providerId: input.model.providerId,
          modelID: input.model.id,
          accountId,
          firstChunkTimeoutMs: STREAM_FIRST_CHUNK_TIMEOUT_MS,
          elapsedMs: elapsed,
        })
        idleController.abort(new Error(`stream first-chunk timeout after ${STREAM_FIRST_CHUNK_TIMEOUT_MS}ms`))
      }, STREAM_FIRST_CHUNK_TIMEOUT_MS)
    }
    armIdleWatchdog()
    const composedAbortSignal = AbortSignal.any([input.abort, idleController.signal])

    return streamText({
      onChunk: () => {
        if (!firstChunkReceived) {
          firstChunkReceived = true
          if (firstChunkTimer) {
            clearTimeout(firstChunkTimer)
            firstChunkTimer = undefined
          }
        }
        armIdleWatchdog()
      },
      onFinish: async (event) => {
        disarmIdleWatchdog()
        const usage = event.usage as any
        const totalTokens = usage
          ? (usage.promptTokens || usage.inputTokens || 0) + (usage.completionTokens || usage.outputTokens || 0)
          : 0
        const cacheReadTokens = usage?.cacheReadTokens ?? usage?.cache?.read ?? 0
        const cacheWriteTokens = usage?.cacheWriteTokens ?? usage?.cache?.write ?? 0

        // Paper-data sink: emit per-turn completion event for freerun sessions.
        // Pairs with the freerun.iteration.start emitted at LLM.stream entry;
        // BusSink writes both to <dataHome>/storage/freerun/<id>/events.jsonl.
        if (effectiveMode === "freerun") {
          try {
            const turnIdx = (input as any).__freerunTurnIdx ?? 0
            const t0 = (input as any).__freerunTurnT0 ?? Date.now()
            await FreerunBus.emit.iterationCompleted({
              sessionID: input.sessionID,
              iteration: turnIdx,
              nodeID: "session-root",
              latencyMs: Date.now() - t0,
              tokensIn: usage?.promptTokens ?? usage?.inputTokens,
              tokensOut: usage?.completionTokens ?? usage?.outputTokens,
              finishReason: event.finishReason ?? undefined,
              validationResult: "ok",
            })
          } catch (err) {
            process.stderr.write(
              `[freerun-debug] paper sink iterationCompleted THREW: ${err instanceof Error ? err.message : err}\n`,
            )
          }
        }
        debugCheckpoint("llm.packet", "LLM inbound packet observed", {
          sessionID: input.sessionID,
          providerId: input.model.providerId,
          modelID: input.model.id,
          accountId,
          finishReason: event.finishReason,
          totalTokens,
          cacheReadTokens,
          cacheWriteTokens,
          usageKeys: usage ? Object.keys(usage).sort() : [],
          responseMessageCount: event.response?.messages?.length ?? 0,
          responseKeywords: Array.from(
            collectCacheKeywords({
              usage,
              providerMetadata: event.providerMetadata,
              response: event.response,
            }),
          ),
          responseShape: {
            hasProviderMetadata: !!event.providerMetadata,
            providerMetadataKeys:
              event.providerMetadata && typeof event.providerMetadata === "object"
                ? Object.keys(event.providerMetadata as Record<string, unknown>).sort()
                : [],
            hasResponse: !!event.response,
          },
          trace: input.sessionID,
        })
        // Diagnostic: trace empty finishes
        if (totalTokens === 0 && event.finishReason === "unknown") {
          process.stderr.write(
            `[DIAG:llm-empty-finish] session=${input.sessionID} model=${input.model.id} provider=${input.model.providerId} account=${accountId} finishReason=${event.finishReason} text=${JSON.stringify((event.text ?? "").slice(0, 100))} toolCalls=${JSON.stringify(event.toolCalls?.length ?? 0)} responseMessages=${JSON.stringify(event.response?.messages?.length ?? 0)} rawHeaders=${JSON.stringify((event.response as any)?.headers ?? {}).slice(0, 200)}\n`,
          )
        }
        RequestMonitor.get().recordRequest(input.model.providerId, accountId || "unknown", input.model.id, totalTokens)

        // Working Cache L1 capture (plans/20260507_working-cache-local-cache/
        // DD-8 / DD-9). Scan BOTH the visible text and the reasoning content
        // for `cache-digest` fenced blocks. Reasoning channel is preferred —
        // codex / anthropic surface reasoning as a separate part type that
        // front-end collapses by default, so emission there leaves the visible
        // chat clean. Providers without reasoning fall back to text emission;
        // front-end renders the fenced block as a collapsed pill.
        try {
          const sources: string[] = []
          if (typeof event.text === "string" && event.text.length > 0) {
            sources.push(event.text)
          }
          // event.response.messages[i].content[j] carries reasoning items as
          // { type: "reasoning", text } per LanguageModelV2 — see
          // packages/provider-codex/src/provider.ts ~line 472.
          const responseMessages = (event as any)?.response?.messages
          if (Array.isArray(responseMessages)) {
            for (const m of responseMessages) {
              const parts = m?.content
              if (!Array.isArray(parts)) continue
              for (const part of parts) {
                if (part?.type === "reasoning" && typeof part.text === "string") {
                  sources.push(part.text)
                }
              }
            }
          }
          for (const source of sources) {
            if (!source.includes("```cache-digest")) continue
            const blocks = WorkingCache.parseDigestBlocks(source, input.sessionID)
            for (const block of blocks) {
              if (block.entry) {
                await WorkingCache.record(block.entry).catch((err) => {
                  log.warn("working-cache.record failed", {
                    sessionID: input.sessionID,
                    error: err instanceof Error ? err.message : String(err),
                  })
                })
              } else if (block.error) {
                log.warn("working-cache.digest-block.malformed", {
                  sessionID: input.sessionID,
                  code: block.error.code,
                  message: block.error.message,
                })
              }
            }
          }
        } catch (err) {
          log.warn("working-cache.parse failed", {
            sessionID: input.sessionID,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
      async onError(error) {
        disarmIdleWatchdog()
        l.error("stream error", { error: serializeError(error) })

        debugCheckpoint("rotation.error", "LLM onError received provider error", {
          providerId: input.model.providerId,
          modelID: input.model.id,
          accountId,
          sessionID: input.sessionID,
          errorDetail: serializeErrorForDebug(error),
        })

        // Publish raw error to webapp sidebar — fires for ALL errors
        {
          const details = serializeErrorForDebug(error)
          const status = typeof details.status === "number" ? details.status : undefined
          const msg =
            typeof details.message === "string"
              ? details.message
              : error instanceof Error
                ? error.message
                : typeof error === "object" && error !== null
                  ? JSON.stringify(error)
                  : String(error)
          Bus.publish(LlmErrorEvent, {
            providerId: input.model.providerId,
            modelId: input.model.id,
            accountId: accountId || "unknown",
            sessionID: input.sessionID,
            status,
            message: msg.length > 300 ? msg.slice(0, 300) + "…" : msg,
            timestamp: Date.now(),
          }).catch(() => {})
        }

        if (!accountId) return

        // @event_20260216_rate_limit_judge: Delegate all classification to RateLimitJudge
        // Judge handles: error classification, backoff calculation, provider-specific strategy,
        // tracker updates, and Bus event broadcasting — all in one call.

        if (isAuthError(error)) {
          await RateLimitJudge.recordAuthFailure(input.model.providerId, accountId, input.model.id, error)

          // Show persistent error toast
          publishToastTraced(
            {
              title: "Authentication Failed",
              message: `Auth failed for ${accountId}. Please re-authenticate.`,
              variant: "error",
              duration: 15000,
              scope: "session",
            },
            { source: "llm.onError.auth" },
          ).catch(() => {})
          return
        }

        if (isRateLimitError(error)) {
          // Classify & update trackers + broadcast RateLimitEvent.Detected to bus.
          // Toast is intentionally NOT shown here — the retry loop in processor.ts
          // will either rotate (showing an "info" toast) or surface a session error
          // when all accounts are exhausted.  Showing a "warning" toast here was
          // redundant noise when rotation succeeds moments later.
          await RateLimitJudge.judge(input.model.providerId, accountId, input.model.id, error)
        }
      },
      async experimental_repairToolCall(failed) {
        const toolName = failed.toolCall.toolName
        const lower = toolName.toLowerCase()
        if (lower !== toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }

        // Active Loader: check if tool exists in lazyTools and auto-unlock it
        if (input.lazyTools?.has(toolName)) {
          const { UnlockedTools: UnlockedToolsMod } = await import("@/session/unlocked-tools")
          UnlockedToolsMod.unlock(input.sessionID, [toolName])
          // Add lazy tool to active tools so it can be called on NEXT attempt
          const lazyTool = input.lazyTools.get(toolName)
          if (lazyTool) {
            tools[toolName] = lazyTool
            l.info("auto-unlocked lazy tool on demand", {
              sessionID: input.sessionID,
              toolID: toolName,
            })

            // The tool is now registered with its full schema, so execute the
            // LLM's original call directly instead of taxing every first use
            // with a forced retry. This is safe because the AI SDK does NOT
            // structurally validate tool args here — tools are registered via
            // `jsonSchema(schema)` with no `validate` fn (resolve-tools.ts), so
            // `safeValidateTypes` short-circuits to success. The real check is
            // the tool's own zod parse at execute time (tool.ts), which carries
            // `Question.normalize`-style preprocess + `formatValidationError`.
            // Net effect: args that are already correct (the common case, since
            // the lazy catalog exposes a param signature) run on the first call
            // with no wasted round-trip; wrong args still fail at execute and
            // surface the tool's rich `[schema-miss:]` hint while the model
            // retries — now with the full schema in the active set. Same safety
            // net as the old forced-retry, minus the mandatory tax.
            //
            // Guard: only pass through when the model's input is valid JSON (or
            // empty — the SDK coerces "" → {}). Malformed JSON falls back to the
            // `invalid` redirect so it self-heals via our InvalidTool rather
            // than the AI SDK's native invalid-tool-call path.
            // Typed-arg repair (bug_20260617): the ANTML-salvage path
            // (provider-claude) stringifies EVERY <parameter> body, so an
            // array/object/number arg arrives as a JSON-string literal
            // (`"[\"daemon\"]"`). Under the Active Loader this is the dominant
            // path for deferred tools (off the wire → no structured tool_use
            // slot). Coerce against the just-unlocked tool's own schema BEFORE
            // pass-through so the value matches what the tool's zod parse
            // demands; conservative — only re-types fields whose schema names a
            // concrete non-string type and whose parsed value matches.
            const rawInput = CoerceArgs.coerceToolCallInput(failed.toolCall.input, CoerceArgs.jsonSchemaOf(lazyTool))
            const inputParseable =
              typeof rawInput !== "string" ||
              rawInput.trim() === "" ||
              (() => {
                try {
                  JSON.parse(rawInput)
                  return true
                } catch {
                  return false
                }
              })()
            if (inputParseable) {
              return {
                ...failed.toolCall,
                input: rawInput,
                toolName,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: toolName,
                error: `Tool "${toolName}" loaded. Retry — full schema is now available.`,
              }),
              toolName: "invalid",
            }
          }
        }

        // Tool IS in the active set — schema validation failed on a tool the
        // LLM already has full visibility into (e.g. todowrite missing a
        // required field, question with empty args). Redirect to `invalid`
        // (same pattern as the unknown-tool branch below) so the LLM sees a
        // normal tool result with the validation issues and self-corrects
        // on the next turn, instead of the UI rendering a red ContentError.
        //
        // This is NOT a violation of AGENTS.md 第一條 (no silent fallback):
        // the failure is in LLM↔tool input negotiation, not in internal
        // execution. The call never reached the tool's execute(), the LLM
        // still receives the error via the `invalid` tool's output (so it
        // can retry), and dev visibility is preserved via the l.warn below.
        // Internal-execution failures still throw and surface as before.
        const activeHit = tools[toolName] ?? tools[lower]
        if (activeHit) {
          // Typed-arg repair, second seam (bug_20260617): a deferred tool
          // already unlocked earlier IN THIS SAME request is in the active set,
          // so a repeat ANTML-salvaged call skips the lazy branch above and its
          // stringified typed args fail the tool's zod parse here. Try the same
          // schema-aware coercion; if it actually changed the input, re-run the
          // corrected call instead of burning the turn on an `invalid` redirect.
          const coerced = CoerceArgs.coerceToolCallInput(failed.toolCall.input, CoerceArgs.jsonSchemaOf(activeHit))
          if (coerced !== failed.toolCall.input) {
            l.info("typed-arg coercion repaired active-tool call — re-running", {
              sessionID: input.sessionID,
              tool: toolName,
            })
            return {
              ...failed.toolCall,
              input: coerced,
              toolName: tools[toolName] ? toolName : lower,
            }
          }
          const alwaysPresent = ALWAYS_PRESENT_TOOLS.has(toolName) || ALWAYS_PRESENT_TOOLS.has(lower)
          l.warn("tool call schema validation failed — redirecting to invalid for self-heal", {
            sessionID: input.sessionID,
            tool: toolName,
            alwaysPresent,
            error: failed.error.message,
          })
          return {
            ...failed.toolCall,
            input: JSON.stringify({
              tool: toolName,
              error: failed.error.message,
            }),
            toolName: "invalid",
          }
        }

        l.warn("unknown tool call — redirecting to invalid", {
          sessionID: input.sessionID,
          tool: toolName,
          error: failed.error.message,
          lazyKnown: input.lazyTools ? [...input.lazyTools.keys()].length : 0,
        })
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: toolName,
            error: failed.error.message,
            // bug_20260622: mark non-existent-tool redirects so the invalid sink
            // tells the model to STOP retrying the phantom name rather than
            // phrasing it as a fixable args error (→ perseveration loop).
            kind: "unknown",
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: requestProviderOptions,
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens,
      abortSignal: composedAbortSignal,
      headers: {
        ...(accountId ? { "x-opencode-account-id": accountId } : {}),
        ...(input.model.providerId.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.api.npm === "@opencode-ai/provider-codex"
            ? {
                session_id: input.sessionID,
                "x-opencode-session": input.sessionID,
                // @plans/provider-hotfix Phase 2 — context-window lineage
                // baseline (upstream codex-rs 9e19004bc2). Empty-string
                // sentinels surface a "top-level session" explicitly instead
                // of relying on header absence.
                "x-opencode-parent-session": parentSessionID ?? "",
                "x-opencode-subagent": subagentSession ? (input.agent.name ?? "") : "",
              }
            : input.model.api.npm !== "@opencode-ai/provider-claude"
              ? {
                  "User-Agent": `opencode/${Installation.VERSION}`,
                }
              : undefined),
        ...(effectiveMode === "freerun"
          ? {
              "x-opencode-mode": "freerun",
              "x-opencode-session-id": input.sessionID,
              // DD-14 / R12: iteration + node coords are injected by the freerun
              // engine's own LlmClient (provider/llm-client.ts) when it dispatches
              // engine-driven calls. From opencode's session/llm.ts path the only
              // freerun-relevant signal is "this provider is freerun-tagged".
            }
          : undefined),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages: finalMessages,
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                const params = args.params as { messages?: ModelMessage[]; prompt?: ModelMessage[] }
                const prompt = Array.isArray(params.messages) ? params.messages : params.prompt
                if (!Array.isArray(prompt)) return args.params
                const next = ProviderTransform.message(prompt as ModelMessage[], input.model, options)
                if (Array.isArray(params.messages)) {
                  params.messages = next
                  return args.params
                }
                params.prompt = next
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const disabled = PermissionNext.disabled(Object.keys(input.tools), input.agent.permission)
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }

  function normalizeMessages(messages: Array<ModelMessage | UIMessage>, tools: Record<string, Tool>): ModelMessage[] {
    if (messages.length === 0) return []
    const list: ModelMessage[] = []
    for (const msg of messages) {
      if (isUIMessage(msg)) {
        const converted = convertToModelMessages([msg], { tools: tools as ToolSet })
        list.push(...converted)
        continue
      }
      list.push(msg)
    }
    return list
  }

  function isUIMessage(msg: ModelMessage | UIMessage): msg is UIMessage {
    return typeof msg === "object" && msg !== null && "parts" in msg
  }

  /**
   * Record a successful request for the current provider.
   * Call this after a stream completes successfully.
   *
   * @event_20260216_rate_limit_judge: Delegates to RateLimitJudge.recordSuccess
   * which clears rate limits, updates health, and broadcasts Cleared event.
   */
  export async function recordSuccess(providerId: string, modelID?: string, accountId?: string): Promise<void> {
    log.info("recordSuccess called", { providerId, modelID, accountId })
    debugCheckpoint("health", "llm.recordSuccess", { providerId, modelID, accountId })

    // Session-scoped: caller must supply accountId. Don't fall back to
    // global activeAccount — that records success against the wrong
    // account's health tracker (RCA 2026-05-18).
    if (!accountId) {
      log.warn("recordSuccess: no accountId provided, skipping", { providerId, modelID })
      return
    }
    if (modelID) {
      await RateLimitJudge.recordSuccess(providerId, accountId, modelID)
    } else {
      const { Account } = await import("@/account")
      await Account.recordSuccess(accountId, providerId)
    }
  }

  const PURPOSE_LABELS: Record<string, string> = {
    coding: "擅長程式開發",
    reasoning: "擅長邏輯推理",
    image: "支援圖片處理",
    docs: "擅長文件分析",
    "long-context": "支援長文本",
    audio: "支援音訊處理",
    video: "支援影片處理",
    "rate-limit": "頻率限制",
  }

  /**
   * Check if rate limit handling is needed for a provider.
   * Returns the next available model if rotation is possible.
   *
   * Uses the 3D rotation system to find the best fallback across
   * (provider, account, model) dimensions.
   *
   * @param currentModel - The model that hit rate limit
   * @param strategy - Fallback selection strategy
   * @param triedVectors - Set of already-tried "provider:account:model" keys to avoid infinite loops
   * @param error - Optional error object that triggered the fallback
   */
  export async function handleRateLimitFallback(
    currentModel: Provider.Model,
    strategy: FallbackStrategy = "account-first",
    triedVectors: Set<string> = new Set(),
    error?: unknown,
    currentAccountIdInput?: string,
    sessionIdentity?: { providerId: string; accountId?: string },
    options?: { silent?: boolean },
    sessionID?: string,
  ): Promise<{ model: Provider.Model; accountId?: string } | null> {
    const { Account } = await import("@/account")

    const resolveProviderKey = (Account as any).resolveProvider ?? (Account as any).resolveFamily
    const providerKey = await resolveProviderKey(currentModel.providerId)
    if (!providerKey) return null

    // Session-scoped: caller must supply accountId. Don't fall back to
    // global activeAccount (RCA 2026-05-18).
    const currentAccountId = currentAccountIdInput
    if (!currentAccountId) {
      log.warn("handleRateLimitFallback: no accountId provided, skipping rotation", {
        providerId: currentModel.providerId,
        modelID: currentModel.id,
        sessionID,
      })
      return null
    }

    // === Rotation storm prevention ===
    // Eligibility: only "first-time" rotation attempts (no prior triedVectors)
    // coalesce across concurrent callers. Retry attempts keep per-caller
    // triedVectors semantics and bypass cache/in-flight sharing, but still
    // honor the min-interval anti-cascade guard inside the wrapper.
    const coalesceKey = `${currentModel.providerId}:${currentAccountId}:${currentModel.id}`
    const eligibleForCoalesce = triedVectors.size === 0

    return withRotationCoalesce({
      coalesceKey,
      providerId: currentModel.providerId,
      eligibleForCoalesce,
      shouldCache: (r) => r !== null,
      work: async () => {
        // Build current vector key and add to tried set
        const currentVectorKey = `${currentModel.providerId}:${currentAccountId}:${currentModel.id}`
        triedVectors.add(currentVectorKey)

        // @event_20260216_rate_limit_judge: Delegate marking to RateLimitJudge
        // This replaces ~160 lines of inline cockpit queries, RPD inference, and tracker updates
        await RateLimitJudge.markRateLimited(currentModel.providerId, currentAccountId, currentModel.id, error)

        // Build current vector
        const currentVector: ModelVector = {
          providerId: currentModel.providerId,
          accountId: currentAccountId,
          modelID: currentModel.id,
        }

        // Use 3D rotation to find best fallback
        // Same-provider account rotation is guarded by SameProviderRotationGuard
        // (max once per cooldown). Cross-provider rotation is unrestricted.
        let fallback = await findFallback(currentVector, { strategy, allowSameProviderFallback: true }, triedVectors)

        // SYSLOG: Log findFallback result
        debugCheckpoint("syslog.rotation", "handleRateLimitFallback: findFallback returned", {
          currentVector: `${currentModel.providerId}:${currentAccountId}:${currentModel.id}`,
          fallbackResult: fallback
            ? `${fallback.providerId}:${fallback.accountId}:${fallback.modelID} (reason=${fallback.reason})`
            : "null",
          strategy,
          triedVectorCount: triedVectors.size,
          triedVectors: Array.from(triedVectors),
        })

        if (!fallback) {
          // Hotfix 2026-05-02: resolve via family so this also fires for per-account
          // providerIds (codex-subscription-<slug>), not only the literal "codex".
          const currentFamily = (await resolveProviderKey(currentModel.providerId)) ?? currentModel.providerId
          debugCheckpoint("syslog.rotation", "handleRateLimitFallback: no fallback candidate found", {
            currentVector: `${currentModel.providerId}:${currentAccountId}:${currentModel.id}`,
            currentFamily,
            strategy,
            triedVectorCount: triedVectors.size,
            triedVectors: Array.from(triedVectors),
            willThrowCodexFamilyExhausted: currentFamily === "codex",
            note: "all candidates exhausted or rate-limited",
          })
          // @plans/codex-rotation-hotfix Phase 3 — codex family is same-provider-only
          // by design. When the pool is empty AND we came in on codex, it means every
          // codex subscription account is out of 5H / weekly quota. Surface this as a
          // codex-specific error so the operator gets an actionable message instead
          // of the generic "all accounts rate-limited" fallback downstream.
          if (currentFamily === "codex") {
            throw new CodexFamilyExhausted({
              providerId: currentModel.providerId,
              accountId: currentAccountId,
              modelId: currentModel.id,
              triedCount: triedVectors.size,
              message:
                "All codex subscription accounts have exhausted their 5H/weekly quota. " +
                "Wait for the next 5H reset or switch provider manually.",
            })
          }
          return null
        }

        // FIX: Enforce session identity constraint — when a session has pinned
        // provider/account, rotation must NOT escape to a different provider or
        // account. This prevents subagent account drift during rate-limit rotation.
        //
        // Allow cross-provider and cross-account fallback.
        // rotation3d.ts already filters candidates to only include enabled providers
        // with active accounts. The previous identity filter blocked these valid
        // candidates, causing stuck sessions when all same-provider accounts
        // were rate-limited.
        if (fallback.providerId !== currentModel.providerId || fallback.accountId !== currentAccountId) {
          debugCheckpoint("syslog.rotation", "Cross-provider/account fallback selected", {
            fromProviderId: currentModel.providerId,
            fromAccountId: currentAccountId,
            fromModelID: currentModel.id,
            toProviderId: fallback.providerId,
            toAccountId: fallback.accountId,
            toModelID: fallback.modelID,
          })
        }

        // Add the selected fallback to tried vectors to avoid immediate retry in subsequent attempts
        const fallbackKey = `${fallback.providerId}:${fallback.accountId}:${fallback.modelID}`

        // Check if this fallback has already been tried (should be caught by findFallback, but as a safeguard)
        if (triedVectors.has(fallbackKey)) {
          log.warn("Fallback already tried after selection", {
            fallback: fallbackKey,
            triedCount: triedVectors.size,
          })
          return null
        }

        // Mark as tried
        triedVectors.add(fallbackKey)

        // Log the dimension change
        const isSameProvider = fallback.providerId === currentModel.providerId
        const isSameAccount = fallback.accountId === currentAccountId
        const isSameModel = fallback.modelID === currentModel.id

        const fallbackReason = isVectorRateLimited(currentVector) ? "rate-limit" : "unknown"
        // Report the *judged* reason the tracker stored for the vector we are
        // leaving (MODEL_CAPACITY_EXHAUSTED, QUOTA_EXHAUSTED, RATE_LIMIT_SHORT,
        // …) rather than collapsing every rate-limit rotation to a generic
        // RATE_LIMIT_EXCEEDED. The old binary label mislabeled Anthropic
        // overloaded_error (capacity) rotations as rate limits.
        const rotationReason =
          getRateLimitTracker().getReason(currentVector.accountId, currentVector.providerId, currentVector.modelID) ??
          (fallbackReason === "rate-limit" ? "RATE_LIMIT_EXCEEDED" : "UNKNOWN")
        const purposeValue = (fallback as unknown as Record<string, unknown>).purpose
        const purpose = typeof purposeValue === "string" ? purposeValue : fallbackReason
        const reasonLabel = PURPOSE_LABELS[purpose] || fallback.reason

        // Build a concise label: "(429)rate-limit" instead of dumping raw error JSON.
        let errorLabel = `(${reasonLabel})`
        if (error) {
          const errorObject = error && typeof error === "object" ? (error as Record<string, any>) : undefined
          const data =
            errorObject?.data && typeof errorObject.data === "object"
              ? (errorObject.data as Record<string, any>)
              : undefined
          const status = errorObject?.status ?? errorObject?.statusCode ?? data?.status
          errorLabel = status ? `(${status})${reasonLabel}` : `(${reasonLabel})`
        }

        const sanitizedErrorLabel = errorLabel.replace(/\s*Retry later or choose another model\.?/gi, "").trim()

        const fromAcc = Account.getShortId(currentAccountId, currentModel.providerId)
        const toAcc = Account.getShortId(fallback.accountId, fallback.providerId)

        const fromStr = `${currentModel.providerId},${currentModel.id},${fromAcc}`
        const toStr = `${fallback.providerId},${fallback.modelID},${toAcc}`
        const toastMsg = `${sanitizedErrorLabel}\n${fromStr}->\n${toStr}`

        log.info("3D fallback selected", {
          reason: fallback.reason,
          trigger: fallbackReason,
          changes: {
            provider: !isSameProvider,
            account: !isSameAccount,
            model: !isSameModel,
          },
          from: fromStr,
          to: toStr,
        })

        debugCheckpoint("rotation3d", "Executing fallback switch", {
          trigger: fallbackReason,
          strategy: fallback.reason,
          from: fromStr,
          to: toStr,
          changes: {
            provider: !isSameProvider,
            account: !isSameAccount,
            model: !isSameModel,
          },
        })

        // Publish rotation event for LLM status card history chain
        Bus.publish(RotationExecutedEvent, {
          sessionID,
          fromProviderId: currentModel.providerId,
          fromModelId: currentModel.id,
          fromAccountId: currentAccountId,
          toProviderId: fallback.providerId,
          toModelId: fallback.modelID,
          toAccountId: fallback.accountId,
          reason: rotationReason,
          timestamp: Date.now(),
        }).catch(() => {})

        // Append to the per-session recentEvents ring buffer so the Q card
        // surfaces recent rotations without the operator grepping bus events.
        // Dynamic import — same pattern as setActiveImageRefs caller above
        // (avoids static circular dep between llm.ts and session/index.ts).
        if (sessionID) {
          void (async () => {
            const { Session: SessionMod } = await import("@/session")
            await SessionMod.appendRecentEvent(sessionID, {
              ts: Date.now(),
              kind: "rotation",
              rotation: {
                fromProviderId: currentModel.providerId,
                fromAccountId: currentAccountId,
                toProviderId: fallback.providerId,
                toAccountId: fallback.accountId,
                reason: rotationReason,
              },
            })
          })().catch(() => {})
        }

        if (isSameProvider && (!isSameAccount || !isSameModel)) {
          const { getSameProviderRotationGuard, SAME_PROVIDER_ROTATE_COOLDOWN_MS } = await import("@/account/rotation")
          getSameProviderRotationGuard().mark(
            currentModel.providerId,
            currentAccountId,
            fallback.accountId,
            fallback.modelID,
            SAME_PROVIDER_ROTATE_COOLDOWN_MS,
          )
          debugCheckpoint("rotation3d", "Same-provider rotate guard armed", {
            providerId: currentModel.providerId,
            fromAccountId: currentAccountId,
            toAccountId: fallback.accountId,
            modelID: fallback.modelID,
            waitMs: SAME_PROVIDER_ROTATE_COOLDOWN_MS,
          })
        }

        // If same model but different account, keep the model object and return a
        // session-local account override instead of mutating global active account.
        if (isSameModel && !isSameAccount && isSameProvider) {
          // Notify user of account rotation (debounced; suppressed for background sessions)
          if (!options?.silent) {
            const now1 = Date.now()
            if (now1 - lastRotationToastAt >= TOAST_DEBOUNCE_MS) {
              lastRotationToastAt = now1
              publishToastTraced(
                {
                  message: toastMsg,
                  variant: "info",
                  duration: 8000,
                  scope: sessionID ? "session" : "user",
                },
                { source: "llm.rotation.sameProvider" },
              ).catch(() => {})
            }
          }

          // Return currentModel here, as the rotation only changed the account.
          return { model: currentModel, accountId: fallback.accountId }
        }

        // If different model or provider, get the full model info
        const fallbackModel = await Provider.getModel(fallback.providerId, fallback.modelID)
        if (!fallbackModel) {
          log.warn("Fallback model not found", {
            providerId: fallback.providerId,
            modelID: fallback.modelID,
          })
          // If fallback model info can't be found, add it to tried and search again
          triedVectors.add(fallbackKey)
          return handleRateLimitFallback(
            currentModel,
            strategy,
            triedVectors,
            error,
            currentAccountId,
            sessionIdentity,
            options,
            sessionID,
          )
        }

        // Notify user of model/provider rotation (debounced; suppressed for background sessions)
        if (!options?.silent) {
          const now2 = Date.now()
          if (now2 - lastRotationToastAt >= TOAST_DEBOUNCE_MS) {
            lastRotationToastAt = now2
            publishToastTraced(
              {
                message: toastMsg,
                variant: "info",
                duration: 8000,
                scope: sessionID ? "session" : "user",
              },
              { source: "llm.rotation.crossProvider" },
            ).catch(() => {})
          }
        }

        return { model: fallbackModel, accountId: fallback.accountId }
      },
    })
  }

  // formatRateLimitReason moved to @/account/rate-limit-judge.ts
}
