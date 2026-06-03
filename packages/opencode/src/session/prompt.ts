import z from "zod"
import { type Tool as AITool, jsonSchema, tool } from "ai"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { debugCheckpoint } from "@/util/debug"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { classifyProvider } from "../provider/chain-semantics"
import { isSupportedProviderKey } from "../provider/supported-provider-registry"
import { SessionCompaction } from "./compaction"
import { detectIdentityChange } from "./identity-change"
import { transformPostAnchorTail, LayerPurityViolation } from "./post-anchor-transform"
import { expandAnchorCompactedPrefix } from "./anchor-prefix-expand"
import { Memory } from "./memory"
import { Token } from "../util/token"
import { Config } from "@/config/config"
import { Instance } from "../project/instance"
import { Todo } from "./todo"
import { Bus } from "../bus"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { Plugin } from "../plugin"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { clone } from "remeda"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { Command } from "../command"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { resolveTools } from "./resolve-tools"
import { resolveImageRequest, stripImageParts } from "./image-router"
import { TaskTool } from "@/tool/task"
import { ToolInvoker } from "./tool-invoker"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { SessionStatus } from "./status"
import {
  assertNotBusy as assertNotBusyRuntime,
  start as startRuntime,
  cancel as cancelRuntime,
  finish as finishRuntime,
  enqueueCallback,
  consumeCallbacks,
  waitForSlot as waitForRuntimeSlot,
  isRuntimeRegistered,
  type CancelReason,
} from "./prompt-runtime"
import { TuiEvent, publishToastTraced } from "@/cli/cmd/tui/event"
import { runShellPrompt } from "./shell-runner"
import { getPreloadedContext, getPreloadParts } from "./preloaded-context"
import { insertReminders } from "./reminders"
import { ensureTitle } from "./title-manager"
import { resolvePromptParts as resolvePromptPartsInner } from "./prompt-part-resolver"
import { renderCommandTemplate } from "./command-template"
import { executeHandledCommand } from "./command-handler-executor"
import { prepareCommandPrompt } from "./command-prompt-prep"
import { dispatchCommandPrompt } from "./command-dispatcher"
import { persistUserMessage } from "./user-message-persist"
import { prepareUserMessageContext } from "./user-message-context"
import { buildUserMessageParts } from "./user-message-parts"
import { materializeToolAttachments } from "./attachment-ownership"
import { emitSessionNarration, isNarrationAssistantMessage } from "./narration"
import { isClaudeContextProvider, CLAUDE_CACHE_TTL_MS, projectClaudeAnchors } from "./claude-context-policy"
import {
  decideAutonomousContinuation,
  describeAutonomousNextAction,
  clearPendingContinuation,
  collectCompletedSubagents,
  enqueueAutonomousContinue,
  getPendingContinuation,
  shouldInterruptAutonomousRun,
} from "./workflow-runner"
import { detectAutorunIntent, extractUserText } from "./autorun/detector"
import { Tweaks } from "@/config/tweaks"
import { RebindEpoch } from "./rebind-epoch"
import { CapabilityLayer, CrossAccountRebindError } from "./capability-layer"
import { registerProductionCapabilityLoader } from "./capability-layer-loader"
import { emitCompactionPredicateTelemetry, emitContextBudgetTelemetry } from "./compaction-telemetry"
import { lastModel } from "./last-model"

// Production capability-layer loader is registered once per process. The
// context resolver reads runtime-known fields (agent, isSubagent) from the
// session the loader is asked to serve. prompt.ts is a natural bootstrap
// location because every LLM round flows through this module.
let _capabilityLoaderRegistered = false
/**
 * responsive-orchestrator DD-3 / DD-3.1 — render one PendingSubagentNotice
 * into a one-line system-prompt addendum. Main agent consumes this string
 * as part of its system message on the next turn; the user never sees it.
 *
 * Format design (keep LLM-friendly, human-parseable, stable wording):
 *   [subagent <childSessionID> finished status=<status> elapsed=<seconds>s<extras>]<hint>
 *
 * extras:
 *   rate_limited → errorDetail.resetsInSeconds
 *   quota_low    → rotateHint.exhaustedAccountId + remainingPercent
 *                  + explicit "rotate before next dispatch" instruction
 *   cancelled    → cancelReason (echo)
 *
 * hint: success → none. Every non-success status carries an inline
 *   read_subsession(sessionID="<id>") reference so the parent agent
 *   can inspect the raw child transcript when the result field is
 *   incomplete (subagent_self_rotation plan §4).
 */
export function renderNoticeAddendum(n: MessageV2.PendingSubagentNotice): string {
  const elapsedSec = Math.round(n.elapsedMs / 1000)
  const base = `[subagent ${n.childSessionID} finished status=${n.status} finish=${n.finish} elapsed=${elapsedSec}s`
  const tail: string[] = []
  if (n.status === "rate_limited" && n.errorDetail?.resetsInSeconds) {
    tail.push(`resets_in_seconds=${n.errorDetail.resetsInSeconds}`)
  }
  if (n.status === "quota_low" && n.rotateHint) {
    tail.push(`exhaustedAccount=${n.rotateHint.exhaustedAccountId}`)
    if (typeof n.rotateHint.remainingPercent === "number") {
      tail.push(`remainingPercent=${n.rotateHint.remainingPercent}`)
    }
    tail.push(`directive=${n.rotateHint.directive}`)
  }
  if (n.status === "canceled" && n.cancelReason) {
    tail.push(`reason=${JSON.stringify(n.cancelReason)}`)
  }
  if (n.result?.type === "inline" && n.result.text) {
    tail.push(`result=${JSON.stringify(n.result.text)}`)
  }
  if (n.result?.type === "attachment_ref" && n.result.refID) {
    tail.push(`result_ref=${n.result.refID}`)
    if (typeof n.result.byteSize === "number") tail.push(`result_bytes=${n.result.byteSize}`)
    if (typeof n.result.estTokens === "number") tail.push(`result_est_tokens=${n.result.estTokens}`)
    if (n.result.preview) tail.push(`result_preview=${JSON.stringify(n.result.preview)}`)
  }
  const tailStr = tail.length > 0 ? " " + tail.join(" ") : ""
  // For every non-success status, point the parent at read_subsession as
  // the canonical inspection route. The result field above may be empty
  // or incomplete (especially for rate_limited / worker_dead); the child
  // session summary (assistant text + tool metadata, output bodies stripped)
  // is available through this MCP tool.
  const readSubsessionHint = ` Inspect the child session summary via \`read_subsession(sessionID="${n.childSessionID}")\` if you need more than the result above.`
  const hint =
    n.status === "success"
      ? ""
      : n.status === "rate_limited"
        ? ` The subagent exhausted its rotation candidates; pick a different account or wait for reset before redispatching.${readSubsessionHint}`
        : n.status === "quota_low"
          ? ` Switch to a different account before any further dispatch.${readSubsessionHint}`
          : n.status === "canceled"
            ? ` The subagent was canceled; its work may be partial.${readSubsessionHint}`
            : n.status === "worker_dead" || n.status === "silent_kill"
              ? ` The subagent did not complete cleanly.${readSubsessionHint}`
              : readSubsessionHint
  return `${base}${tailStr}]${hint}`
}

function ensureCapabilityLoaderRegistered() {
  if (_capabilityLoaderRegistered) return
  _capabilityLoaderRegistered = true
  registerProductionCapabilityLoader(async (sessionID) => {
    const session = await Session.get(sessionID).catch(() => undefined)
    if (!session) return undefined
    // Agent selection: prefer the session's latest user-message agent; fall
    // back to "main" for silent refresh (where no user message exists).
    const stream = MessageV2.stream(sessionID)
    let agentName: string | undefined
    try {
      for await (const item of stream) {
        if (item.info.role === "user") {
          agentName = (item.info as MessageV2.User).agent
        }
      }
    } catch {
      // best-effort; silent-refresh path lacks a recent user message
    }
    return {
      sessionID,
      epoch: RebindEpoch.current(sessionID),
      agent: { name: agentName ?? (session.parentID ? "coding" : "main") },
      isSubagent: !!session.parentID,
    }
  })
}

globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

// Claude-compatible proactive reminder — the per-turn behavioral steering claude
// needs to stop "光說不做" (announce-a-step-then-end_turn). RCA: claude genuinely
// emits end_turn to defer/announce mid-task; the anti-punt tuning that stabilized
// codex (reasoning_effort, chain-init nudges) is a no-op for claude (SL provider).
// Official Claude Code counters the same disposition with a per-turn `isMeta`
// turnReminder ("Execute autonomously, prefer action over planning") — a knob
// claude lacks, so we mirror the *reminder*. Injected ephemerally onto the tail
// turn each loop iteration (sessionMessages is a clone — never persisted) so it
// is re-injected every turn, survives compaction, and does not decay.
const CLAUDE_PROACTIVE_REMINDER = [
  "<system-reminder>",
  "Execute autonomously. Keep working until the task is fully done. Prefer action over narration:",
  "when the next step is something you can do yourself, DO IT NOW in this same turn — do not",
  "announce it and stop. Make reasonable assumptions for routine, low-risk decisions instead of",
  "pausing to ask. Only hand back to the user for genuinely destructive actions (deleting data,",
  "modifying shared/production systems) or a real preference fork you cannot resolve yourself.",
  "</system-reminder>",
].join("\n")

// Phase 13.1: captureTurnSummaryOnExit removed. TurnSummaries are no longer
// persisted to a separate Memory file — they're derived at read time by
// `Memory.read(sid)` walking the messages stream and extracting the last
// text part of each finished assistant message. Single source of truth.

/**
 * Estimate the token count of a reconstructed message stream (post-filter or
 * post-rebind). Walks every part and sums Token.estimate over text, tool
 * input, tool output, and reasoning bodies.
 *
 * Why this exists: `lastFinished.tokens.total` reflects the PREVIOUS LLM
 * call's input size — it's stale once `applyStreamAnchorRebind` reshapes
 * `msgs` into `[syntheticSummary, ...postBoundary]`. The state-driven
 * compaction trigger needs to know "what's the UPCOMING prompt going to
 * weigh?", which is a function of the current `msgs`, not the last
 * round's input. This helper computes that estimate.
 *
 * Cheap to compute (string length / 4) and runs at most once per
 * runloop iteration; not a hot path.
 */
export function estimateMsgsTokenCount(msgs: MessageV2.WithParts[]): number {
  let total = 0
  for (const m of msgs) {
    for (const p of m.parts) {
      if (p.type === "text") {
        total += Token.estimate((p as MessageV2.TextPart).text ?? "")
      } else if (p.type === "reasoning") {
        total += Token.estimate((p as any).text ?? "")
      } else if (p.type === "tool" && p.state.status === "completed") {
        const inp = (p.state as any).input
        if (inp != null) {
          total += Token.estimate(typeof inp === "string" ? inp : JSON.stringify(inp))
        }
        const out = (p.state as any).output
        if (out != null) {
          total += Token.estimate(typeof out === "string" ? out : JSON.stringify(out))
        }
      }
    }
  }
  return total
}

type ContextBudgetStatus = "green" | "yellow" | "orange" | "red"

export function contextBudgetStatus(
  ratio: number,
  thresholds = Tweaks.compactionSync().budgetStatusThresholds,
): ContextBudgetStatus {
  const [greenMax, yellowMax, orangeMax] = thresholds
  if (ratio < greenMax) return "green"
  if (ratio < yellowMax) return "yellow"
  if (ratio < orangeMax) return "orange"
  return "red"
}

function renderContextBudget(input: { lastFinished: MessageV2.Assistant; model: Provider.Model }): string | undefined {
  const window = input.model.limit.input ?? input.model.limit.context
  const used = input.lastFinished.tokens?.input ?? 0
  if (!window || window <= 0 || used <= 0) {
    emitContextBudgetTelemetry({ emitted: false, reason: "missing_window_or_usage", window, used })
    return undefined
  }
  const cacheRead = input.lastFinished.tokens?.cache?.read ?? 0
  const ratio = used / window
  const cacheHitRate = used + cacheRead > 0 ? cacheRead / (used + cacheRead) : 0
  emitContextBudgetTelemetry({
    emitted: true,
    window,
    used,
    ratio,
    status: contextBudgetStatus(ratio),
    cacheRead,
    cacheHitRate,
  })
  return [
    "<context_budget>",
    `window: ${window}`,
    `used: ${used}`,
    `ratio: ${ratio.toFixed(2)}`,
    `status: ${contextBudgetStatus(ratio)}`,
    `cache_read: ${cacheRead}`,
    `cache_hit_rate: ${cacheHitRate.toFixed(2)}`,
    "as_of: end_of_turn_N-1",
    "</context_budget>",
  ].join("\n")
}

// DD-19: resolve the context-budget text so the CALLER can put it in the uncached
// preface trailing tier (the `system` array). Returns undefined when there is
// nothing to show, no finished source, or the provider is lite (small local
// models parrot the <context_budget> block back as the visible response).
//
// This REPLACES the old `withContextBudgetEnvelope`, which spliced the budget as a
// synthetic part INTO the last user message — i.e. inside the cached conversation
// prefix. Because the block carries per-turn-changing numbers (used/ratio/
// cache_read/cache_hit_rate), that splice invalidated the whole conversation cache
// every turn the numbers changed → the mid-runloop "cache 跑了" cold drops.
// Official claude-code never splices a mutating value into a cached message; it
// keeps volatile per-turn context in the tail. See datasheet.md §2 / DD-18.
async function resolveContextBudgetText(input: {
  lastFinished?: MessageV2.Assistant
  model: Provider.Model
}): Promise<string | undefined> {
  if (!input.lastFinished) return undefined
  try {
    const cfg = await Config.get()
    const providerCfg = (
      cfg.provider as Record<string, { mode?: "full" | "lite" | "freerun"; lite?: boolean }> | undefined
    )?.[input.model.providerId]
    const effectiveMode = providerCfg?.mode ?? (providerCfg?.lite === true ? "lite" : "full")
    if (effectiveMode === "lite") return undefined
  } catch {
    // Config read failure → fall through (preserve existing behaviour).
  }
  return renderContextBudget({ lastFinished: input.lastFinished, model: input.model }) || undefined
}

/**
 * Pure gate for the empty-response self-heal compaction at line ~1279.
 *
 * Returns `overflowSuspected=true` only when the last well-formed turn was
 * already past the configured floor (default 0.8 — matches the 80-85%
 * codex silent-overflow window the original 2026-04-29 hotfix targeted).
 * Below that floor the empty round is most likely a transient SSE/network
 * blip and the runloop should fall through to the cheap nudge path
 * instead of paying for destructive compaction.
 */
export function evaluateEmptyResponseGate(input: { used: number; window: number; floor: number }): {
  overflowSuspected: boolean
  ratio: number
} {
  if (!Number.isFinite(input.window) || input.window <= 0) return { overflowSuspected: false, ratio: 0 }
  const ratio = input.used / input.window
  return { overflowSuspected: ratio >= input.floor, ratio }
}

function findContextBudgetSource(messages: MessageV2.WithParts[]): MessageV2.Assistant | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info.role !== "assistant") continue
    const assistant = info as MessageV2.Assistant
    if (!assistant.finish) continue
    if ((assistant.tokens?.input ?? 0) <= 0) continue
    return assistant
  }
  return undefined
}

function buildContextBudgetPolicyInput(input: { lastFinished?: MessageV2.Assistant; model: Provider.Model }): {
  status: "green" | "yellow" | "orange" | "red" | "unknown"
  ratio?: number
  used?: number
  window?: number
  source: "last-finished" | "unavailable"
} {
  const window = input.model.limit.input ?? input.model.limit.context
  const used = input.lastFinished?.tokens?.input ?? 0
  if (!input.lastFinished || !window || window <= 0 || used <= 0) {
    return { status: "unknown", source: "unavailable" }
  }
  const ratio = used / window
  return { status: contextBudgetStatus(ratio), ratio, used, window, source: "last-finished" }
}

/**
 * compaction-redesign phase 6 — state-driven runloop evaluator (DD-1).
 *
 * Each runloop iteration calls this to decide whether SessionCompaction.run
 * should fire and what `observed` value to pass. Reads only **observable
 * session state** — no flags, no signals, no remembered intent from prior
 * iterations. State staleness is impossible because each call recomputes
 * from current Memory + session.execution + message-stream tail.
 *
 * Priority order is declared in TRIGGER_INVENTORY so tests can pin the
 * trigger contract separately from the predicate implementation.
 *
 * The "subagent / cron / parent" exclusion mirrors the pre-existing
 * legacy guards in the runloop: this function returns null when
 * `session.parentID` is set so subagent sessions don't self-compact.
 */
export const TRIGGER_INVENTORY = Object.freeze([
  { id: "cooldown", observed: null, description: "cooldown blocks compaction" },
  { id: "manual", observed: "manual", description: "user-initiated compaction request" },
  { id: "auto-request", observed: "overflow", description: "system compaction request" },
  {
    id: "continuation-invalidated",
    observed: "continuation-invalidated",
    description: "provider rejected continuation chain",
  },
  {
    id: "provider-switched",
    observed: "provider-switched",
    description: "anchor provider differs from pinned provider",
  },
  {
    id: "account-rebind",
    observed: null,
    description: "same-provider account drift only invalidates remote continuation",
  },
  { id: "overflow", observed: "overflow", description: "prompt exceeds usable context budget" },
  { id: "stall-recovery", observed: "stall-recovery", description: "consecutive empty high-context rounds" },
  { id: "predicted-cache-miss", observed: "cache-aware", description: "predicted cache miss at high context" },
  { id: "quota-pressure", observed: null, description: "quota pressure placeholder disabled until schema is pinned" },
  { id: "cache-aware", observed: "cache-aware", description: "prompt crosses cache-aware threshold" },
  {
    id: "cache-cliff",
    observed: "continuation-invalidated",
    description: "cache_read dropped >50% between turns — server lost chain",
  },
] as const)

/**
 * Per-session cache_read tracker for detecting catastrophic server-side
 * cache loss. When cache_read drops dramatically between consecutive turns
 * (same account, no compaction), the server silently evicted the chain
 * and the model is running on a near-empty context. The only recovery is
 * a continuation-invalidated rebind that forces full prompt resend.
 *
 * Incident 2026-05-19 ses_1c875cc15ffe5ds18JVdNAT4e6: codex server
 * evicted 193K cache mid-session; client kept sending delta; model ran
 * on 3K tokens for 10+ minutes producing repetitive nonsense.
 *
 * 2026-05-24 (cache-cliff-false-positive-chain-reset): tracker extended
 * to remember accountId / providerId / continuationInvalidatedAt / our
 * own prior invalidate so we can classify drops as planned (we caused
 * them) vs unplanned (server silently evicted). Only unplanned drops
 * invalidate; planned drops are telemetry-only.
 */
type CacheReadState = {
  cacheRead: number
  accountId: string | undefined
  providerId: string
  continuationInvalidatedAt: number | undefined
  ts: number
  /** True if the previous turn's cliff check decided to invalidate. The
   *  immediate next turn's cache_read will naturally drop as the server
   *  re-caches from the full resend — that echo is planned, not a cliff. */
  selfInvalidated: boolean
}
const lastCacheReadState = new Map<string, CacheReadState>()

export async function deriveObservedCondition(input: {
  sessionID: string
  step: number
  msgs: MessageV2.WithParts[]
  lastFinished: MessageV2.Assistant | undefined
  pinnedProviderId: string
  pinnedAccountId: string | undefined
  hasUnprocessedCompactionRequest: boolean
  /**
   * `auto` field on the unprocessed compaction-request part. true =
   * system-initiated (overflow-equivalent, allows synthetic Continue);
   * false = user-initiated /compact. undefined when no part exists.
   */
  compactionRequestAuto: boolean | undefined
  parentID: string | undefined
  /** DD-11: epoch ms set by codex Bus listener when previous_response_id was rejected. */
  continuationInvalidatedAt: number | undefined
  predictedCacheMiss?: "miss" | "hit" | "unknown"
  currentInputTokens?: number
  modelContextWindow?: number
  isOverflow: () => Promise<boolean>
  isCacheAware: () => Promise<boolean>
}): Promise<SessionCompaction.Observed | null> {
  // Cooldown gate. SessionCompaction.run() also checks this and short-circuits;
  // but checking here lets us return null cleanly without going through run().
  if (await SessionCompaction.Cooldown.shouldThrottle(input.sessionID)) {
    return null
  }

  // DD-12: subagents use the same path as parents EXCEPT they do not
  // accept "manual" (no UI surface). Manual is suppressed for subagents
  // even if some upstream code accidentally appends a compaction-request
  // part. All other observed values are evaluated identically.
  const isSubagent = !!input.parentID
  if (input.hasUnprocessedCompactionRequest && !isSubagent) {
    // compaction-request with auto:true is system-initiated (overflow-equivalent
    // — caller wants synthetic Continue injection); auto:false is user-initiated.
    return input.compactionRequestAuto === true ? "overflow" : "manual"
  }

  // Cache cliff detection: if cache_read dropped >50% from the previous
  // turn AND the previous turn had substantial cache (>50K), the server
  // silently lost the chain. Response: reset the WS continuation chain
  // so the next call sends full input (not delta), allowing the server
  // to rebuild its cache from the unchanged prompt. Do NOT trigger
  // compaction — compaction rewrites the anchor, producing a brand-new
  // prefix the server hasn't seen, which under high-pressure load gets
  // evicted again immediately → compaction cascade.
  //
  // Incident 2026-05-19: codex server evicted cache under load; old code
  // returned "continuation-invalidated" here → narrative compaction →
  // full resend with new anchor → server evicts again → 37 cascading
  // compactions in 2 hours (ses_1c875cc15ffe5ds18JVdNAT4e6).
  if (input.lastFinished) {
    const finished = input.lastFinished
    const currentCache = finished.tokens.cache.read ?? 0
    const prev = lastCacheReadState.get(input.sessionID)
    const nextState: CacheReadState = {
      cacheRead: currentCache,
      accountId: input.pinnedAccountId,
      providerId: input.pinnedProviderId,
      continuationInvalidatedAt: input.continuationInvalidatedAt,
      ts: Date.now(),
      selfInvalidated: false,
    }

    // The cache_read-drop predicate below is a *stateful-chain* (SS) concept.
    // codex/OpenAI report a single cached-vs-uncached axis, so a >50% drop in
    // cache_read from a substantial prior turn means the server silently dropped
    // the chain and is reprocessing at full rate — a real cliff. Anthropic and
    // the rest of the SL (stateless prompt-cache) family bill cache in two parts
    // — read (0.1x) and write/creation (1.25x) — so a low-read/high-write turn
    // is just the prefix being (re)written while it is STILL fully cached, not a
    // loss. Measuring cache_read alone there cried wolf on every re-cache turn.
    // For SL the real "cache gave us nothing" signal is the uncached `input`
    // share, which getUsage already isolates (Anthropic reports inputTokens
    // EXCLUDING cached). classifyProvider throws on unknown ids (DD-11), so gate
    // on the supported-key check; unknown providers keep the SS predicate.
    const providerClass = isSupportedProviderKey(input.pinnedProviderId)
      ? classifyProvider(input.pinnedProviderId)
      : undefined

    if (providerClass === "SL") {
      // read + write ≈ total ⇒ input ≈ 0 ⇒ the whole prompt was served from or
      // written to cache: no cliff, however the read/write split moved this turn.
      // Only a genuinely large uncached share (cache_control didn't cover the
      // prompt) is worth surfacing. The invalidate path below is a codex-only
      // no-op for SL, so this branch is telemetry-only — never return null.
      const t = finished.tokens
      const promptTotal = t.input + t.cache.read + t.cache.write
      const uncachedFraction = promptTotal > 0 ? t.input / promptTotal : 0
      if (promptTotal > 50_000 && uncachedFraction > 0.5) {
        debugCheckpoint("prompt", "cache_miss_detected", {
          sessionID: input.sessionID,
          step: input.step,
          promptTotal,
          uncachedInput: t.input,
          cacheRead: t.cache.read,
          cacheWrite: t.cache.write,
          uncachedFraction,
        })
        void Session.appendRecentEvent(input.sessionID, {
          ts: Date.now(),
          kind: "cache-cliff",
          cacheCliff: {
            prevCacheRead: promptTotal,
            currentCacheRead: t.cache.read + t.cache.write,
          },
        }).catch(() => {})
      }
      lastCacheReadState.set(input.sessionID, nextState)

      // context/claude-refactor DD-13/14/16/18: claude cold-cache size-gated
      // compaction. The SL telemetry above never compacts; claude must compact
      // when the cold resend is BOTH expensive (cache served <half the prompt)
      // AND large, so subsequent turns send a bounded supersede-framed
      // anchor+tail instead of the full 1M array on every cold (>5min TTL)
      // resend. The trigger gates on observable context SIZE + cache-read share
      // only — NEVER on the codex `cache_read`-drop=chain-lost heuristic in the
      // SS branch below — so it is structurally cascade-immune (post-compaction
      // the array shrinks below the gate → no re-trigger; negative feedback).
      // Warm-near-window growth stays covered by the existing `overflow`
      // trigger. claude-gated: other SL providers (gemini) keep the
      // telemetry-only path byte-identical (INV-0). "cache-aware" → KIND_CHAIN
      // ["narrative","ai_paid"] and is NOT a CLAUDE_NOOP_OBSERVED, so it
      // produces a real supersede-framed anchor on the claude path.
      // context/claude-refactor DD-23: B-compaction threshold is per-provider,
      // absolute tokens, tunable via tweak config (compaction_ctx_<provider>_b_tokens).
      // claude-cli default 100K; other providers fall back to the `default` profile.
      const bCompactTokens = Tweaks.contextThresholdsSync(input.pinnedProviderId).bCompactTokens
      if (isClaudeContextProvider(input.pinnedProviderId) && promptTotal > bCompactTokens) {
        // DD-16 cold detection has TWO sources, OR'd:
        //  (1) cache_read share < half  → the LAST turn was cold (active-session).
        //  (2) idle gap > cache TTL     → SESSION RESUME / rebind: enough time has
        //      passed that the ephemeral cache is GONE, so the NEXT request is a
        //      guaranteed cold full-prefill — regardless of the previous turn's
        //      (now-stale) recorded cache split. Without (2), a session whose last
        //      turn was warm would full-prefill its whole array on first cold
        //      resume, unbounded. resume==rebind here: claude has no server chain
        //      to rebind, so the resume work is purely "cache dead → bound the
        //      resend"; codex's chain reset is handled separately in the SS branch.
        const cacheReadFraction = promptTotal > 0 ? t.cache.read / promptTotal : 0
        const lastCompletedAt = finished.time?.completed ?? finished.time?.created ?? 0
        const idleMs = lastCompletedAt > 0 ? Date.now() - lastCompletedAt : 0
        const idleColdResume = idleMs > CLAUDE_CACHE_TTL_MS
        if (cacheReadFraction < 0.5 || idleColdResume) {
          // F2 / DD-5 (claude-gated, loop-B defense-in-depth): if a compaction
          // anchor was written AFTER our last observation, the current active-
          // session cold is the EXPECTED post-compaction warm-up echo — the
          // freshly rewritten prefix is not cached server-side yet — NOT cache
          // thrash. Compacting again on it is exactly the self-feeding cascade
          // (loop B). The top-of-function 30s Cooldown.shouldThrottle covers the
          // within-30s window; this guard catches the FIRST cold turn after that
          // window expires (e.g. a slow tool turn). It fires for at most one turn
          // (prev.ts advances past the anchor on the next observation). Idiom
          // mirrors the SS branch's `recent_compaction` planned-source classifier
          // below. idleColdResume (TTL elapsed) is a genuine cold prefill
          // regardless of anchor age, so it is NEVER suppressed here.
          const recentAnchor = findMostRecentAnchor(input.msgs)
          const postCompactionEcho =
            !idleColdResume &&
            !!prev &&
            !!recentAnchor?.createdAt &&
            recentAnchor.createdAt > prev.ts
          if (postCompactionEcho) {
            debugCheckpoint("prompt", "claude_cold_gate_recent_compaction_skip", {
              sessionID: input.sessionID,
              step: input.step,
              promptTotal,
              cacheReadFraction,
              anchorCreatedAt: recentAnchor!.createdAt,
              prevObservedAt: prev!.ts,
            })
            // fall through — do not compact on the expected post-compaction cold
          } else {
            debugCheckpoint("prompt", "claude_cold_compaction_gate", {
              sessionID: input.sessionID,
              step: input.step,
              promptTotal,
              cacheRead: t.cache.read,
              cacheReadFraction,
              idleMs,
              idleColdResume,
              gate: bCompactTokens,
            })
            return "cache-aware"
          }
        }
      }
    } else if (prev !== undefined && prev.cacheRead > 50_000 && currentCache < prev.cacheRead * 0.5) {
      // Classify: did WE cause this drop? If yes it's planned — telemetry
      // only, fall through to remaining triggers. If no it's a real
      // unplanned server-side eviction — invalidate as before.
      const plannedSources: string[] = []
      if (prev.selfInvalidated) plannedSources.push("self_invalidate_echo")
      if (prev.accountId !== input.pinnedAccountId) plannedSources.push("account_switch")
      if (prev.providerId !== input.pinnedProviderId) plannedSources.push("provider_switch")
      if (
        input.continuationInvalidatedAt !== undefined &&
        input.continuationInvalidatedAt !== prev.continuationInvalidatedAt
      ) {
        plannedSources.push("continuation_invalidated_event")
      }
      // Anchor drift: the line-549 identity-drift handler may have run on
      // a prior turn (which itself returns null and updates our prev to
      // the new accountId) — but the anchor still carries the old account
      // until a compaction rewrites it, so the cache won't rebind for
      // several turns. Treat any unresolved anchor drift as planned.
      const anchor = findMostRecentAnchor(input.msgs)
      if (anchor) {
        if (anchor.accountId && input.pinnedAccountId && anchor.accountId !== input.pinnedAccountId) {
          plannedSources.push("anchor_account_drift")
        }
        if (anchor.providerId && anchor.providerId !== input.pinnedProviderId) {
          plannedSources.push("anchor_provider_drift")
        }
        // Recent compaction echo: anchor was written *after* our last
        // observation, so the new prefix wasn't cached on the server yet.
        // The cooldown gate at the top already blocks the within-30s
        // window; this catches the first turn after cooldown expires.
        if (anchor.createdAt && anchor.createdAt > prev.ts) {
          plannedSources.push("recent_compaction")
        }
      }

      if (plannedSources.length > 0) {
        debugCheckpoint("prompt", "cache_cliff_planned", {
          sessionID: input.sessionID,
          step: input.step,
          prevCacheRead: prev.cacheRead,
          currentCacheRead: currentCache,
          dropRatio: currentCache / prev.cacheRead,
          plannedSources,
        })
        lastCacheReadState.set(input.sessionID, nextState)
        // Do not invalidate — drop was expected. Fall through.
      } else {
        debugCheckpoint("prompt", "cache_cliff_detected", {
          sessionID: input.sessionID,
          step: input.step,
          prevCacheRead: prev.cacheRead,
          currentCacheRead: currentCache,
          dropRatio: currentCache / prev.cacheRead,
        })
        void Session.appendRecentEvent(input.sessionID, {
          ts: Date.now(),
          kind: "cache-cliff",
          cacheCliff: {
            prevCacheRead: prev.cacheRead,
            currentCacheRead: currentCache,
          },
        }).catch(() => {})
        // Chain-reset only: invalidate WS continuation so the next call
        // sends the full (unchanged) prompt instead of delta. The server
        // re-caches the same prefix it already knows — no compaction needed.
        try {
          const { invalidateContinuationFamily } = await import("@opencode-ai/provider-codex/continuation")
          invalidateContinuationFamily(input.sessionID)
        } catch {}
        nextState.selfInvalidated = true
        lastCacheReadState.set(input.sessionID, nextState)
        // Return null — no compaction. The runloop proceeds to the LLM
        // call with the existing prompt, just without delta mode.
        return null
      }
    } else {
      lastCacheReadState.set(input.sessionID, nextState)
    }
  }

  // Item-count pressure: codex WS has an undocumented item-array limit.
  // Payloads past ~250 items trigger ws_truncation (empty response,
  // finishReason=unknown). Unlike token overflow this is transport-level
  // — the only fix is shrinking the message stream before the next call.
  // Check independently of lastFinished: even the first call can exceed
  // the threshold if the session accumulated items across restarts.
  //
  // MUST run before identity-drift / rebind checks — those return null
  // (chain reset only, no compaction), but a 500-item session needs
  // compaction regardless of account switch.
  if (estimateCodexItemCount(input.msgs) > 350) return "overflow"

  // DD-11: continuation-invalidated takes priority over identity drift.
  // The signal is fresh iff the timestamp is newer than the most recent
  // Anchor's time.created (state-driven cooldown via anchor-recency
  // comparison; no flag-clear step needed).
  const lastAnchor = findMostRecentAnchor(input.msgs)
  if (
    input.continuationInvalidatedAt &&
    (!lastAnchor || input.continuationInvalidatedAt > (lastAnchor.createdAt ?? 0))
  ) {
    return "continuation-invalidated"
  }

  // Identity drift since last anchor.
  //
  // Provider switch — tool-call format & system prompt change → must compact.
  //
  // Account-only switch (same provider) — aligned with the pre-loop fix
  // (commit f63e1138f, "account switch triggers chain reset only, not full
  // compaction"): tool-call format unchanged, full conversation fidelity
  // should be preserved. Only codex's server-side previous_response_id chain
  // needs cutting. Awaited invalidateContinuationFamily (no-op for non-codex
  // providers) so the per-account swap path inside transport-ws reads the
  // cleared disk state on the next outbound request. Previously this was
  // fire-and-forget (`void (async)`), which raced the next streamText call
  // and let the swap path restore a stale lastResponseId from disk —
  // observable on rotation-heavy sessions as orphan turns / repeated empty
  // streams (incident 2026-05-10 ses_1ee7b8bccffeG73CQxXDDSw3og).
  if (lastAnchor) {
    if (lastAnchor.providerId && lastAnchor.providerId !== input.pinnedProviderId) {
      return "provider-switched"
    }
    if (lastAnchor.accountId && input.pinnedAccountId && lastAnchor.accountId !== input.pinnedAccountId) {
      // 2026-05-12 (Phase C of session/rebind-procedure-revision): the
      // chain reset is now dispatched through Continuation.run so the
      // next outbound also carries a chain_init_notice with commitment
      // digest. The classifier returns breaksChain=true + injectsChainInit
      // for SS providers (codex / copilot / openai), and breaksChain=false
      // + injectsChainInit=false for SL providers — preserving the prior
      // "no-op for non-codex" invariant of the direct call.
      const { Continuation } = await import("./continuation/run")
      await Continuation.run({
        kind: "account_switch",
        sessionID: input.sessionID,
        previousAccountId: lastAnchor.accountId,
        accountId: input.pinnedAccountId,
        providerId: lastAnchor.providerId ?? input.pinnedProviderId,
      }).catch(() => {
        // Continuation.run is internally best-effort; outer catch is for
        // any import / synchronous-throw case so the decision flow still
        // returns null below.
      })
      return null
    }
  }

  // Token-pressure conditions (from the existing isOverflow / cache-aware
  // helpers; we accept them as injected predicates so this function stays
  // pure-ish and testable).
  if (input.lastFinished) {
    if (await input.isOverflow()) return "overflow"

    const compactionTweak = Tweaks.compactionSync()
    const window = input.modelContextWindow ?? 0
    const currentInputTokens = input.currentInputTokens ?? input.lastFinished.tokens.input
    const ctxRatio = window > 0 ? currentInputTokens / window : 0

    if (
      countTrailingEmptyAssistantResponses(input.msgs) >= compactionTweak.stallRecoveryConsecutiveEmpty &&
      ctxRatio > compactionTweak.stallRecoveryFloor
    ) {
      return "stall-recovery"
    }

    if (input.predictedCacheMiss === "miss" && ctxRatio > compactionTweak.cacheLossFloor) {
      const cacheRead = input.lastFinished.tokens.cache.read ?? 0
      const predictedUncached = Math.max(0, currentInputTokens - cacheRead)
      if (predictedUncached >= compactionTweak.minUncachedTokens) return "cache-aware"
    }

    if (await input.isCacheAware()) return "cache-aware"
  }

  return null
}

/**
 * Estimate the number of codex Responses API input items in a message
 * stream. Codex WS has an undocumented item-array limit (~400-500);
 * payloads past ~250 items start hitting ws_truncation intermittently.
 *
 * Counting rules (mirrors codex's input serialisation):
 *   - 1 per user message
 *   - 1 per assistant text part with content
 *   - 1 per tool call (function_call)
 *   - 1 per completed/errored tool output (function_call_output)
 */
export function estimateCodexItemCount(msgs: MessageV2.WithParts[]): number {
  let count = 0
  for (const m of msgs) {
    if (m.info.role === "user") {
      count += 1
      continue
    }
    if (m.info.role === "assistant") {
      const hasText = m.parts.some(
        (p) =>
          p.type === "text" &&
          typeof (p as { text?: string }).text === "string" &&
          ((p as { text: string }).text.length ?? 0) > 0,
      )
      if (hasText) count += 1
      for (const p of m.parts) {
        if (p.type !== "tool") continue
        count += 1
        const status = (p as MessageV2.ToolPart).state?.status
        if (status === "completed" || status === "error") count += 1
      }
    }
  }
  return count
}

/**
 * Check whether the LAST user message contains attachment_ref parts that
 * have not yet been dispatched to the `attachment` tool (completed OR
 * errored). Only the latest user message is checked — older unread refs
 * from previous turns must not permanently lock the agent into
 * attachment-only mode.
 *
 * Bug history:
 *   - Pre-fix: scanned ALL messages; a 429 on any historical ref locked
 *     the agent forever because `error` was not counted as "attempted".
 *   - First fix: counted `error` as attempted, but old refs that were
 *     never even attempted (skipped by the model) still locked the gate.
 *   - Current: scope the gate to the latest user message only. If the
 *     model skips an older ref, that's its choice — not a deadlock.
 */
function hasUnreadAttachmentRefs(msgs: MessageV2.WithParts[]): boolean {
  // Find the last user message
  let lastUserMsg: MessageV2.WithParts | undefined
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].info.role === "user") {
      lastUserMsg = msgs[i]
      break
    }
  }
  if (!lastUserMsg) return false

  // Collect attachment_refs from the last user message only
  const seen = new Set<string>()
  for (const part of lastUserMsg.parts) {
    if (part.type === "attachment_ref") {
      seen.add(part.ref_id)
    }
  }
  if (seen.size === 0) return false

  // Scan ALL messages for attachment tool calls that cover these refs
  const attempted = new Set<string>()
  for (const msg of msgs) {
    for (const part of msg.parts) {
      if (
        part.type === "tool" &&
        part.tool === "attachment" &&
        (part.state.status === "completed" || part.state.status === "error")
      ) {
        const refID = (part.state.input as { ref_id?: unknown })?.ref_id
        if (typeof refID === "string") attempted.add(refID)
      }
    }
  }

  for (const ref of seen) {
    if (!attempted.has(ref)) return true
  }
  return false
}

function countTrailingEmptyAssistantResponses(msgs: MessageV2.WithParts[]): number {
  let count = 0
  let sawUserBoundary = false
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.info.role === "user") {
      sawUserBoundary = true
      break
    }
    if (msg.info.role !== "assistant") break
    const assistant = msg.info as MessageV2.Assistant
    const hasModelVisibleContent = msg.parts.some(
      (part) => part.type === "text" || part.type === "tool" || part.type === "reasoning",
    )
    if (hasModelVisibleContent) break
    if ((assistant.tokens?.input ?? 0) <= 0 || (assistant.tokens?.output ?? 0) > 0) break
    count++
  }
  return sawUserBoundary ? count : 0
}

/**
 * Find the most recent compaction anchor in the message stream. The anchor
 * is an assistant message with `summary: true` (compactWithSharedContext
 * writes it). Carries providerId / modelID / accountId for state-driven
 * rebind detection (INV-7: anchor identity reflects time-of-write).
 */
export function findMostRecentAnchor(msgs: MessageV2.WithParts[]): {
  providerId: string
  modelID: string
  accountId: string | undefined
  messageId: string
  createdAt: number | undefined
} | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const info = msgs[i].info
    if (info.role === "assistant" && (info as MessageV2.Assistant).summary === true) {
      const a = info as MessageV2.Assistant
      return {
        providerId: a.providerId,
        modelID: a.modelID,
        accountId: a.accountId,
        messageId: a.id,
        createdAt: a.time?.created,
      }
    }
  }
  return null
}

/**
 * Index variant of `findMostRecentAnchor` — returns the message stream
 * position so callers can slice. Phase 13.2: stream-anchor-based rebind
 * recovery uses this directly; no disk file needed.
 */
export function findMostRecentAnchorIndex(msgs: MessageV2.WithParts[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const info = msgs[i].info
    if (info.role === "assistant" && (info as MessageV2.Assistant).summary === true) {
      return i
    }
  }
  return -1
}

function isTakeoverAnchorMessage(msg: MessageV2.WithParts | undefined): boolean {
  if (!msg || msg.info.role !== "assistant") return false
  return msg.parts.some(
    (part) => part.type === "text" && (part as MessageV2.TextPart).metadata?.takeoverAnchor === true,
  )
}

export function shouldReuseProviderSwitchAnchor(input: {
  messages: MessageV2.WithParts[]
  anchorIndex: number
}): boolean {
  const anchor = input.messages[input.anchorIndex]
  if (!isTakeoverAnchorMessage(anchor)) return true
  return !input.messages.slice(input.anchorIndex + 1).some((msg) => msg.info.role === "user")
}

/**
 * Phase 13.2: rebind by stream-anchor scan. Slices the message stream from
 * the most recent anchor onward (anchor included — its text is the
 * compacted summary). Drops everything before the anchor since that
 * history is no longer live context.
 *
 * Safety: refuses to slice if the first post-anchor message is an
 * assistant with completed/orphaned tool calls (would error on next LLM
 * call). Returns the original input unchanged in that case.
 *
 * No anchor in stream → returns input unchanged. Caller treats this as
 * "fresh session, nothing to rebind".
 */
export function applyStreamAnchorRebind(msgs: MessageV2.WithParts[]): {
  applied: boolean
  messages: MessageV2.WithParts[]
  anchorIndex: number
  reason?: "no_anchor" | "unsafe_boundary"
} {
  const anchorIdx = findMostRecentAnchorIndex(msgs)
  if (anchorIdx === -1) return { applied: false, messages: msgs, anchorIndex: -1, reason: "no_anchor" }
  const firstPost = msgs[anchorIdx + 1]
  const unsafe =
    firstPost?.info.role === "assistant" &&
    firstPost.parts.some((p) => p.type === "tool" && (p as any).state?.status && (p as any).state.status !== "pending")
  if (unsafe) return { applied: false, messages: msgs, anchorIndex: anchorIdx, reason: "unsafe_boundary" }
  return { applied: true, messages: msgs.slice(anchorIdx), anchorIndex: anchorIdx }
}

/**
 * Extract the AI's natural turn-end self-summary from an assistant message's
 * parts. Concatenates all `text` parts in document order (handles assistants
 * that produced multiple text parts interleaved with reasoning / tool calls).
 * Returns empty string if no text content exists.
 */
export function extractFinalAssistantText(parts: MessageV2.Part[] | undefined): string {
  if (!parts) return ""
  return parts
    .filter((p): p is MessageV2.TextPart => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim()
}

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  /**
   * Reset the cache baseline for a session after compaction. Without this,
   * the first post-rebind round (which naturally has low cache — only the
   * anchor prefix hits) is compared against the pre-compaction cache value,
   * triggering a false cache-cliff → continuation-invalidated → compaction
   * loop. Incident 2026-05-19 ses_1c875cc15ffe5ds18JVdNAT4e6: 37 cascading
   * compactions in 2 hours from this self-reinforcing cycle.
   */
  export function resetCacheBaseline(sessionID: string) {
    lastCacheReadState.delete(sessionID)
  }

  export function assertNotBusy(sessionID: string) {
    return assertNotBusyRuntime(sessionID)
  }

  export const PromptInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    model: z
      .object({
        providerId: z.string(),
        modelID: z.string(),
        accountId: z.string().optional(),
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: MessageV2.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    autonomous: z.boolean().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, async (input) => {
    const session = await Session.get(input.sessionID)
    await SessionRevert.cleanup(session)

    // Ensure workflow exists; reset completed sessions to idle without force-enabling autorun
    await Session.update(
      input.sessionID,
      (draft) => {
        const current = draft.workflow ?? Session.defaultWorkflow(draft.time.updated)
        if (!draft.workflow || current.state === "completed") {
          draft.workflow = {
            ...current,
            state: current.state === "completed" ? "idle" : current.state,
            stopReason: undefined,
            updatedAt: Date.now(),
          }
        }
      },
      { touch: false },
    )

    const message = await createUserMessage(input, session)
    await Session.touch(input.sessionID)

    // specs/autonomous-opt-in/ Phase 4 (new Phase 1) — verbal arm/disarm
    // Inspect the incoming user text for configured trigger / disarm phrases
    // (loaded from /etc/opencode/tweaks.cfg under autorun_*_phrases). A match
    // flips workflow.autonomous.enabled; the normal runLoop → continuation
    // path picks up the new flag state without extra enqueue. Silent no-op
    // when no phrase present — zero behavior change for users who never use
    // the feature.
    try {
      const autorunCfg = Tweaks.autorunSync()
      const userText = extractUserText(
        input.parts as ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>,
      )
      const intent = detectAutorunIntent(userText, autorunCfg)
      if (intent) {
        const enable = intent.kind === "arm"
        const current = (await Session.get(input.sessionID)).workflow?.autonomous.enabled
        if (current !== enable) {
          await Session.updateAutonomous({ sessionID: input.sessionID, policy: { enabled: enable } })
          log.info("autorun " + intent.kind + " via verbal trigger", {
            sessionID: input.sessionID,
            phrase: intent.phrase,
            previous: current,
            next: enable,
          })
        } else {
          log.info("autorun " + intent.kind + " phrase detected but state unchanged", {
            sessionID: input.sessionID,
            phrase: intent.phrase,
            enabled: current,
          })
        }
      }
    } catch (err) {
      // Detector/config is best-effort — a failure here must never block
      // the user's actual prompt. Log and continue.
      log.warn("autorun intent detection failed", {
        sessionID: input.sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    const permissions: PermissionNext.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,
        action: enabled ? "allow" : "deny",
        pattern: "*",
      })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      await Session.update(session.id, (draft) => {
        draft.permission = permissions
      })
    }

    if (input.noReply === true) {
      return message
    }

    // ── Freerun mode auto-arm autonomous ──────────────────────────────
    // When this session's provider is freerun-tagged, autonomous-opt-in is
    // ON by default. The user's message is treated like any other prompt;
    // the runloop just doesn't stop between turns. Everything else (system
    // prompt FREERUN.md addendum, task tool strip, sudo gate, compaction
    // bypass) lives at the layers that already see the provider mode.
    try {
      await maybeArmFreerunAutonomous(input)
    } catch (err) {
      log.warn("freerun auto-arm failed; continuing in normal mode", {
        sessionID: input.sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const shouldReplaceRuntime = await shouldInterruptForIncomingPrompt(input.sessionID)
    if (shouldReplaceRuntime && (message.info.model ?? input.model)) {
      await emitSessionNarration({
        sessionID: input.sessionID,
        parentID: message.info.id,
        agent: message.info.agent,
        variant: message.info.variant,
        model: message.info.model ?? input.model ?? { providerId: "", modelID: "" },
        text: "Interrupted the previous autonomous run and replanning around your latest message.",
        kind: "interrupt",
      })
    }
    return runLoop(input.sessionID, { replaceRuntime: shouldReplaceRuntime, incomingModel: input.model })
  })

  /**
   * If the session's provider is freerun-tagged, ensure autonomous-opt-in
   * is on. Freerun's only operational difference from a normal session is
   * "doesn't stop between turns" — the existing autonomous-continuation
   * machinery drives that; we just auto-arm it on first prompt.
   *
   * Everything else (FREERUN.md system-prompt addendum, task tool strip,
   * sudo gate, compaction bypass) is applied at the layers that already
   * detect freerun mode (session/llm.ts, tool/bash.ts, session/compaction.ts).
   */
  async function maybeArmFreerunAutonomous(input: {
    sessionID: string
    model?: { providerId: string; modelID: string }
  }): Promise<void> {
    const session = await Session.get(input.sessionID).catch(() => null)
    if (!session) return
    const providerId = session.execution?.providerId ?? input.model?.providerId
    if (!providerId) return
    const cfg = await Config.get()
    const providerCfg = (cfg.provider as Record<string, { mode?: "full" | "lite" | "freerun" }> | undefined)?.[
      providerId
    ]
    if (providerCfg?.mode !== "freerun") return

    // Already armed? Leave it. (User may have explicitly disarmed mid-session.)
    if (session.workflow?.autonomous.enabled === true) return

    await Session.updateAutonomous({
      sessionID: input.sessionID,
      policy: { enabled: true },
    }).catch((err) => {
      log.warn("freerun auto-arm failed", {
        sessionID: input.sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    return (await resolvePromptPartsInner(template)) as PromptInput["parts"]
  }

  export function createStructuredOutputTool(input: {
    schema: Record<string, any>
    onSuccess: (output: unknown) => void
  }): AITool {
    const { $schema, ...toolSchema } = input.schema
    return tool({
      id: "StructuredOutput" as any,
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      inputSchema: jsonSchema(toolSchema as Record<string, unknown>),
      async execute(args) {
        input.onSuccess(args)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput(result) {
        return {
          type: "text",
          value: result.output,
        }
      },
    })
  }

  function start(sessionID: string, options?: { replace?: boolean }) {
    return startRuntime(sessionID, options)
  }

  export function cancel(sessionID: string, reason: CancelReason) {
    log.info("cancel", { sessionID, reason })
    cancelRuntime(sessionID, reason)
    void clearPendingContinuation(sessionID).catch(() => undefined)
    void Session.setWorkflowState({
      sessionID,
      state: "waiting_user",
      // `manual_interrupt` remains the canonical workflow stop reason so the
      // NON_RESUMABLE_WAITING_REASONS gate continues to block auto-resume.
      // The `reason` argument is separately surfaced via the telemetry log
      // line above and via AbortSignal.reason inside prompt-runtime.cancel.
      stopReason: "manual_interrupt",
      lastRunAt: Date.now(),
    }).catch(() => undefined)
  }

  const emitAutonomousNarration = emitSessionNarration

  async function shouldInterruptForIncomingPrompt(sessionID: string) {
    const status = SessionStatus.get(sessionID)
    if (status.type !== "busy") return false
    // status=busy can mean "runtime running" OR "no runtime, child running"
    // (the post-Phase-9 dispatched-but-still-attached state). Only interrupt
    // when there's an actual runtime to abort — otherwise let the new
    // prompt start a fresh runloop normally.
    if (!isRuntimeRegistered(sessionID)) return false
    const session = await Session.get(sessionID)
    const pending = await getPendingContinuation(sessionID)
    let lastUserSynthetic = false
    for await (const message of MessageV2.stream(sessionID)) {
      if (message.info.role !== "user") continue
      lastUserSynthetic =
        message.parts.length > 0 &&
        message.parts.every((part) => part.type !== "text" || part.synthetic === true || part.ignored === true)
      break
    }
    return shouldInterruptAutonomousRun({
      session,
      status,
      lastUserSynthetic,
      hasPendingContinuation: !!pending,
    })
  }

  export async function handleContinuationSideEffects(input: {
    sessionID: string
    user: MessageV2.User
    decision: Extract<Awaited<ReturnType<typeof decideAutonomousContinuation>>, { continue: true }>
    autonomousRounds: number
    enqueueContinue?: typeof enqueueAutonomousContinue
  }) {
    const enqueueContinue = input.enqueueContinue ?? enqueueAutonomousContinue
    const nextRoundCount = input.autonomousRounds + 1

    await enqueueContinue({
      sessionID: input.sessionID,
      user: input.user,
      roundCount: nextRoundCount,
      text: input.decision.text,
    })
    return {
      halted: false as const,
      nextRoundCount,
      narration: undefined,
    }
  }

  export function resolveTerminalContinuationStopState(
    decision: Extract<Awaited<ReturnType<typeof decideAutonomousContinuation>>, { continue: false }>,
  ) {
    if (decision.reason === "todo_complete") {
      return {
        state: "completed" as const,
        stopReason: "todo_complete" as const,
      }
    }

    return {
      state: "waiting_user" as const,
      stopReason: decision.reason,
    }
  }

  async function runLoop(
    sessionID: string,
    options?: {
      replaceRuntime?: boolean
      incomingModel?: { providerId: string; modelID: string; accountId?: string }
    },
  ) {
    // Race-condition fix: previously, when start() returned undefined because
    // a runloop was still in its post-reply cleanup window (SharedContext
    // update / compaction / pruning — line ~1884-1932), we would enqueue a
    // result-callback that later got drained at the end of the OLD runloop
    // and resolved with the OLD runloop's assistant reply. That silently
    // absorbed the new user message: "here's the reply" the daemon thought
    // it was serving was actually a reply to a different, older prompt.
    // User-visible symptom: first prompt typed right after a runloop just
    // finished got no response, probabilistic with the exact typing timing.
    //
    // Fix: wait for the current runtime slot to release, then start our own
    // runloop against the user message we were invoked for. Bounded retry
    // with replace-on-last-resort so a pathological never-finish runtime
    // can't livelock a fresh prompt.
    let runtime = start(sessionID, { replace: options?.replaceRuntime })
    if (!runtime) {
      for (let attempt = 0; attempt < 3 && !runtime; attempt++) {
        await waitForRuntimeSlot(sessionID)
        runtime = start(sessionID)
      }
      if (!runtime) {
        log.warn("runLoop: slot never opened after waits — forcing replace", { sessionID })
        runtime = start(sessionID, { replace: true })
      }
      if (!runtime) {
        // Absolute last resort: the enqueue path. This should be
        // essentially unreachable, but keep it so a pathological state
        // never blocks the caller silently.
        return new Promise<MessageV2.WithParts>((resolve, reject) => {
          enqueueCallback(sessionID, { resolve, reject })
        })
      }
    }

    const abort = runtime!.signal
    using _ = defer(() => finishRuntime(sessionID, runtime!.runID))

    let structuredOutput: unknown | undefined

    let step = 0
    let autonomousRounds = 0
    let lastDecisionReason: Awaited<ReturnType<typeof decideAutonomousContinuation>>["reason"] | undefined
    let emptyRoundCount = 0
    let paralysisRecoveryCount = 0
    let consecutiveCompactions = 0
    const session = await Session.get(sessionID)
    const cachedInstructionPrompts = await InstructionPrompt.system()
    const environmentCache = new Map<string, string[]>()

    // Context Sharing v3: lightweight parent context for child sessions.
    // Priority: parent stream-anchor slice → SharedContext snapshot → last 10 rounds.
    // Subagents always receive a task instruction, so parent context is
    // supplementary — full history is wasteful and risks overflow.
    const PARENT_CONTEXT_MAX_ROUNDS = 10
    let parentMessagePrefix: MessageV2.WithParts[] | undefined
    let parentContextSource: "checkpoint" | "shared_context" | "recent_history" | "none" = "none"
    if (session.parentID) {
      // Priority 1 (Phase 13.2): scan parent's filtered stream for the most
      // recent compaction anchor; slice from there onward as parent context.
      // The anchor message itself contains the compacted summary text — no
      // disk file involved. Replaces legacy RebindCheckpoint-based reduction.
      const parentFiltered = await MessageV2.filterCompacted(MessageV2.stream(session.parentID))
      const parentRebind = applyStreamAnchorRebind(parentFiltered.messages)
      if (parentRebind.applied) {
        parentMessagePrefix = parentRebind.messages
        parentContextSource = "checkpoint"
        log.info("context sharing: parent stream-anchor applied", {
          sessionID,
          parentID: session.parentID,
          fullCount: parentFiltered.messages.length,
          reducedCount: parentMessagePrefix.length,
        })
      }

      // Phase 13.3-full: Priority 2 (SharedContext snapshot) deleted. The
      // stream-anchor scan in Priority 1 already surfaces compacted summaries
      // when they exist; if no anchor → fall straight through to recent
      // history (Priority 2 below). Removing the regex-extracted text
      // fallback keeps the messages stream as the single source of truth.

      // Priority 2: last N rounds of parent history (bounded)
      if (!parentMessagePrefix) {
        const parentFiltered = await MessageV2.filterCompacted(MessageV2.stream(session.parentID))
        const allMsgs = parentFiltered.messages
        if (allMsgs.length > 0) {
          // Count rounds: each user→assistant pair is one round.
          // Take the last PARENT_CONTEXT_MAX_ROUNDS rounds from the end.
          let roundCount = 0
          let cutoffIndex = allMsgs.length
          for (let i = allMsgs.length - 1; i >= 0; i--) {
            if (allMsgs[i].info.role === "user") {
              roundCount++
              if (roundCount >= PARENT_CONTEXT_MAX_ROUNDS) {
                cutoffIndex = i
                break
              }
            }
          }
          parentMessagePrefix = cutoffIndex === 0 ? allMsgs : allMsgs.slice(cutoffIndex)
          parentContextSource = "recent_history"
          log.info("context sharing: recent history fallback", {
            sessionID,
            parentID: session.parentID,
            fullCount: allMsgs.length,
            slicedCount: parentMessagePrefix.length,
            rounds: roundCount,
          })
        }
      }

      if (parentContextSource === "none") {
        log.info("context sharing: no parent context available", {
          sessionID,
          parentID: session.parentID,
        })
      }
    }

    debugCheckpoint("prompt", "loop:session_loaded", {
      sessionID,
      parentID: session.parentID,
      isSubagent: !!session.parentID,
      title: session.title,
    })

    // ── Pre-loop provider switch detection ──
    // Must run BEFORE the main loop to avoid the expensive filterCompacted scan
    // on a session whose entire history is incompatible with the new provider.
    //
    // Phase 13 hotfix (2026-04-28): compare incomingModel against the most
    // recent ASSISTANT MESSAGE's identity — that's what the codex server
    // actually has cached as `previous_response_id`. The previous comparison
    // (against `session.execution.*`) produced false positives when TUI's
    // `sanitizeModelIdentity` / `replacementAccountId` silently substituted
    // an "available" account at the picker level (e.g. rotation3d marked the
    // pinned account inactive temporarily). The pin would flip in
    // session.execution but the codex server's cache key stayed bound to the
    // ACTUAL account of the last LLM call — forcing a needless rebuild.
    //
    // No assistant messages → fresh session, nothing to invalidate, skip.
    if (!session.parentID && options?.incomingModel) {
      const lastAssistantIdentity = await (async () => {
        const msgs = await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])
        for (let i = msgs.length - 1; i >= 0; i--) {
          const info = msgs[i].info
          if (info.role === "assistant" && (info as MessageV2.Assistant).finish) {
            const a = info as MessageV2.Assistant
            return { providerId: a.providerId, accountId: a.accountId, mode: a.mode, agent: a.agent }
          }
        }
        return undefined
      })()
      // Imported assistant messages carry a historical providerId that
      // doesn't represent a live API chain. Skip provider switch detection
      // so the first post-import prompt doesn't trigger a compaction that
      // swallows the user message. mode="import" covers transcript messages;
      // the takeover anchor has mode="compaction" + agent="claude-import".
      const prevIsImport =
        lastAssistantIdentity?.mode === "import" ||
        (lastAssistantIdentity?.mode === "compaction" && lastAssistantIdentity?.agent === "claude-import")
      const prevProvider = lastAssistantIdentity?.providerId
      const nextProvider = options.incomingModel.providerId
      const prevAccount = lastAssistantIdentity?.accountId
      const nextAccount = options.incomingModel.accountId
      // Identity-change decision is delegated to detectIdentityChange so
      // boundary cases (undefined prev/next, import anchors, fresh session)
      // are unit-tested in isolation. See identity-change.ts for the full
      // history including the 2026-05-26 phantom-switch RCA.
      const identityDecision = detectIdentityChange(
        lastAssistantIdentity
          ? {
              providerId: lastAssistantIdentity.providerId,
              accountId: lastAssistantIdentity.accountId,
              isImport: prevIsImport,
            }
          : undefined,
        { providerId: nextProvider, accountId: nextAccount },
      )
      // Always log the decision (even "none") so phantom-switch regressions
      // and silent skip paths are both greppable under [identity-change].
      // The reason field distinguishes all 8 code paths.
      log.info("identity-change decision", {
        channel: "identity-change",
        sessionID,
        kind: identityDecision.kind,
        reason: identityDecision.reason,
        prevProvider,
        nextProvider,
        prevAccount,
        nextAccount,
        prevIsImport,
      })
      const providerChanged = identityDecision.kind === "provider"
      const accountChanged = identityDecision.kind === "account"
      if (providerChanged) {
        log.warn("provider switch detected (pre-loop), forcing context reinit", {
          sessionID,
          prevProvider,
          nextProvider,
          prevAccount,
          nextAccount,
        })
        // DD-4 order contract: bump rebind epoch FIRST (capability layer will
        // naturally cache-miss on next runLoop iteration and re-read fresh
        // AGENTS.md / driver / skills for the new provider). Only then can
        // compactWithSharedContext safely rebuild conversation-layer messages
        // with the new provider's context — capability layer must be fresh
        // before checkpoint apply.
        ensureCapabilityLoaderRegistered()
        await RebindEpoch.bumpEpoch({
          sessionID,
          trigger: "provider_switch",
          reason: `provider ${prevProvider} → ${nextProvider}`,
        })
        const model = await Provider.getModel(nextProvider, options.incomingModel.modelID).catch(() => undefined)
        if (model) {
          // Phase 13.2: resolution chain is now SharedContext (in-memory) →
          // most recent stream anchor's text → minimal stub. The disk-file
          // Phase 13.3-full: pull snapshot text from the most recent anchor
          // in the stream. SharedContext.snapshot regex extractor is gone;
          // the anchor message itself IS the canonical compacted text.
          // LLM compaction is NOT safe because old provider's tool call
          // history is incompatible.
          let snap: string | undefined
          const filtered = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
          const anchorIdx = findMostRecentAnchorIndex(filtered.messages)
          const reuseAnchor =
            anchorIdx !== -1 &&
            shouldReuseProviderSwitchAnchor({
              messages: filtered.messages,
              anchorIndex: anchorIdx,
            })
          if (reuseAnchor) {
            const anchor = filtered.messages[anchorIdx]
            snap =
              anchor.parts
                .filter((p): p is MessageV2.TextPart => p.type === "text")
                .map((p) => p.text)
                .join("\n")
                .trim() || undefined
          }
          // user-msg-replay-unification DD-3: snapshot the unanswered user
          // msg BEFORE compactWithSharedContext writes the anchor. After
          // the write, replay it post-anchor so the next iter's lastUser
          // resolves to a real message instead of falling through to the
          // synthetic Continue path (INJECT_CONTINUE['provider-switched']
          // is false → no Continue would be injected → silent exit).
          const replaySnapshot = await SessionCompaction.snapshotUnansweredUserMessage(
            sessionID,
            "provider-switched",
          ).catch(() => undefined)
          // Phase 13.1: Memory.markCompacted call removed (Memory.lastCompactedAt
          // is derived from the most recent anchor's time.created, not stored).
          await SessionCompaction.compactWithSharedContext({
            sessionID,
            snapshot:
              snap ??
              `[Provider switched from ${prevProvider} to ${nextProvider}. Previous conversation context was not recoverable. The user may re-state their request.]`,
            model,
            auto: false,
            observed: "provider-switched",
          })
          if (replaySnapshot) {
            const postWriteMsgs = await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])
            const anchorMsg = postWriteMsgs.findLast(
              (m) => m.info.role === "assistant" && (m.info as MessageV2.Assistant).summary === true,
            )
            if (anchorMsg) {
              await SessionCompaction.replayUnansweredUserMessage({
                sessionID,
                snapshot: replaySnapshot,
                anchorMessageID: anchorMsg.info.id,
                observed: "provider-switched",
                step: 0,
              })
            }
          }
          log.info("provider switch compaction complete, entering main loop", { sessionID })
        }
      } else if (accountChanged) {
        // Same provider, different account: tool-call format unchanged, so
        // full compaction would needlessly destroy fidelity. Only two things
        // matter: capability layer must re-bind (account-scoped AGENTS.md /
        // skills may differ), and codex's server-side previous_response_id
        // chain must be cut so the next request starts fresh under the new
        // account. invalidateContinuation is a no-op for non-codex providers.
        log.info("account switch detected (pre-loop), chain reset only (no compaction)", {
          sessionID,
          provider: nextProvider,
          prevAccount,
          nextAccount,
        })
        ensureCapabilityLoaderRegistered()
        // 2026-05-12 (Phase C of session/rebind-procedure-revision):
        // dispatch via Continuation.run instead of the prior pair
        // (RebindEpoch.bumpEpoch + invalidateContinuationFamily).
        // Continuation.run subsumes both — bumps epoch internally with
        // chainBreakClass="SS-break" (codex) / "SL-noop" (anthropic etc.),
        // captures commitment digest BEFORE invalidation (DD-8), marks
        // the next outbound for chain_init_notice injection, and emits
        // chain.commitment.captured + chain.init.injected runtime events.
        const { Continuation } = await import("./continuation/run")
        await Continuation.run({
          kind: "account_switch",
          sessionID,
          previousAccountId: prevAccount ?? "unknown",
          accountId: nextAccount ?? "unknown",
          providerId: nextProvider ?? "unknown",
        }).catch((err) => {
          log.warn("account switch: Continuation.run threw at outer boundary", {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          })
        })
        log.info("account switch: chain reset via Continuation.run", { sessionID })
      }
    }

    while (true) {
      SessionStatus.set(sessionID, { type: "busy" })
      log.info("loop", { step, sessionID })
      if (abort.aborted) break

      // ── Poll subagent mailbox ──────────────────────────────────
      // Dispatch and collect live in the same loop. Every iteration
      // checks if a dispatched subagent has completed.
      // The push path (task-worker-continuation) already persisted the
      // completion message in this session — we just consume the queue
      // entry so the supervisor doesn't also try to resume us, and set
      // a flag so the break logic below knows not to exit this iteration.
      const hasSubagentCompletion = !!(await collectCompletedSubagents(sessionID))
      if (hasSubagentCompletion) {
        log.info("loop: subagent completion collected from queue", { sessionID, step })
      }
      // Firefight (context/claude-refactor INV-1/INV-3): claude is stateless/1M
      // and full-retransmits the neutral SQLite. context/claude-refactor DD-21:
      // filterCompacted is provider-agnostic (stops at the most-recent anchor,
      // INV-0). For claude only, the anchor bodies are re-framed at read time
      // (projectClaudeAnchors → supersede framing) so a stale/foreign/legacy
      // anchor is presented honestly ("earlier portion; recent supersedes")
      // instead of asserting currency — and the session stays bounded by its
      // own most-recent anchor (no full-raw regression on resume). Any
      // non-claude / uncertain provider sees the neutral stored body (INV-0).
      const turnProviderId =
        (await Session.get(sessionID).catch(() => undefined))?.execution?.providerId ??
        options?.incomingModel?.providerId
      const claudeContextPath = isClaudeContextProvider(turnProviderId)
      const filteredResult = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
      let msgs = claudeContextPath ? projectClaudeAnchors(filteredResult.messages) : filteredResult.messages
      if (filteredResult.stoppedByBudget) {
        log.warn("filterCompacted stopped by token budget guard", { sessionID, messageCount: msgs.length })
      }
      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      const processedCompactionParents = new Set<string>()
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (msg.info.role === "assistant") {
          if (isNarrationAssistantMessage(msg.info, msg.parts)) continue
          if (msg.info.parentID) {
            processedCompactionParents.add(msg.info.parentID)
          }
          if (!lastAssistant) lastAssistant = msg.info as MessageV2.Assistant
          if (!lastFinished && msg.info.finish) lastFinished = msg.info as MessageV2.Assistant
        }
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part): part is MessageV2.CompactionPart | MessageV2.SubtaskPart => {
          if (part.type === "compaction-request") {
            // Prevent re-processing the same compaction request when a child assistant
            // message already exists (including failed/unfinished attempts).
            // Otherwise, a failed compaction can get stuck in a retry loop that keeps
            // spawning empty summary messages and blocks normal replies.
            return !processedCompactionParents.has(msg.info.id)
          }
          return part.type === "subtask"
        })
        if (task.length > 0 && !lastFinished) {
          tasks.push(...task)
        }
      }

      // Post-compaction the stream may legitimately contain only the synthetic
      // anchor + compaction summary (both assistant-role); the original user
      // turn has been folded into the summary. The upstream loop assumed
      // every iteration is driven by a fresh user message and panicked here,
      // surfacing a "Compaction failed: UnknownError" toast even though the
      // compaction itself succeeded. Treat the empty-user case as a clean
      // exit instead — runloop has nothing left to drive, return to
      // waiting_user.
      if (!lastUser) {
        log.info("loop:no_user_after_compaction — exiting cleanly", {
          sessionID,
          step,
          messageCount: msgs.length,
          hasLastAssistant: !!lastAssistant,
          hasLastFinished: !!lastFinished,
          taskCount: tasks.length,
        })
        break
      }
      // Imported sessions have no model on user messages. Resolve once
      // so every downstream site can use resolvedModel instead of
      // lastUser.model with optional chaining everywhere.
      const resolvedModel = lastUser.model ?? (await lastModel(sessionID))
      const contextBudgetSource = findContextBudgetSource(msgs)
      const format = lastUser.format ?? { type: "text" }

      // 2026-05-18: ws-truncation × bloated-input compaction REMOVED.
      // Empty response is NOT evidence of context overflow. The cause
      // family can be ws_truncation, server_failed, ws_no_frames, etc.
      // — none of which are fixed by compacting. Real context overflow
      // is handled by deriveObservedCondition (isOverflow / isCacheAware)
      // which uses actual token counts, not empty-response heuristics.
      // The removed block was the root cause of a 100+ cycle compaction
      // flood on session ses_1c875cc1 (2026-05-18): ws_truncation at
      // 34% context → compact → retry → still truncated → compact → ...

      // Guard: detect empty-response loop (finish=unknown|other, 0 tokens).
      // "other" comes from codex SSE/WS that closed without a terminal event,
      // or response.incomplete with an unmapped reason. Same shape as
      // "unknown": empty body, 0 tokens, no parts.
      //
      // 2026-05-12 (Phase E of session/rebind-procedure-revision): also
      // catch finish=error here. The codex SSE→finishReason mapping is
      //   ws_truncation / ws_no_frames / unclassified → "unknown"
      //   server_failed                              → "error"
      //   server_incomplete                          → "other"
      //   server_empty_output_with_reasoning         → "other"
      // i.e. "error" is the server_failed bucket; structurally identical
      // to the empty-response shape (0 tokens, no parts) and wants the
      // same recovery path. Pre-Phase E, error-finish rounds leaked past
      // Phase B's dispatch — transport-ws would do a primitive
      // invalidateContinuationFamily scrub but the AI never received a
      // chain_init_notice on the next outbound, reproducing the跳針 class
      // for server_failed cases.
      //
      // Hotfix 2026-04-29: fail fast instead of injecting a synthetic "?".
      // The nudge polluted the message stream and could add extra retries on
      // Codex context-overflow incidents, making double-reporting harder to
      // diagnose. A real recovery path must be explicit chain invalidation or
      // compaction, not hidden user-message fabrication.
      const isEmptyRound =
        (lastAssistant?.finish === "unknown" ||
          lastAssistant?.finish === "other" ||
          lastAssistant?.finish === "error") &&
        lastAssistant.tokens.input === 0 &&
        lastAssistant.tokens.output === 0 &&
        lastAssistant.id > lastUser.id
      // Continuation event kind dispatched from this site. Differentiates
      // server_failed (backend_failure_forced_resend) from empty-output
      // (empty_response_recovery) so chain.init.injected telemetry carries
      // accurate reason metadata downstream.
      const failureKindForChainInit: "empty_response_recovery" | "backend_failure_forced_resend" =
        lastAssistant?.finish === "error" ? "backend_failure_forced_resend" : "empty_response_recovery"
      // Counter is only reset on positive evidence (a completed turn that
      // actually produced tokens). The injected synthetic nudge below will
      // make lastUser.id > lastAssistant.id on the next iteration, so we
      // can't use that ordering to gate the reset — otherwise the cap never
      // accumulates and we'd nudge forever.
      if (lastAssistant && (lastAssistant.tokens.input > 0 || lastAssistant.tokens.output > 0)) {
        emptyRoundCount = 0
      }
      if (isEmptyRound && lastAssistant) {
        emptyRoundCount = (emptyRoundCount ?? 0) + 1

        // Detect if the prompting user message was a synthetic runtime
        // trigger (autonomous resume, task-summary continuation, our
        // own self-heal nudge, autorun nudge). User rule (memory:
        // feedback_silent_stop_continuation): "在 autonomous runloop
        // continuation 觸發下，若判斷沒有繼續 loop 的需求，就完全
        // 靜默停止 ... Silence 本身就是 runner 期待的 signal."
        //
        // For these synthetic triggers, an empty assistant response is
        // INTENTIONAL compliance, not a failure. Don't nudge, don't
        // red-flag — close the round as a clean stop and exit silently.
        const lastUserParts = msgs.findLast((m) => m.info.id === lastUser.id)?.parts ?? []
        const lastUserAllSynthetic =
          lastUserParts.length > 0 &&
          lastUserParts.every((p) => p.type !== "text" || (p as { synthetic?: boolean }).synthetic === true)
        if (lastUserAllSynthetic) {
          log.info("empty-response after synthetic trigger — natural silent stop", {
            sessionID,
            step,
            emptyRounds: emptyRoundCount,
            isSubagent: !!session.parentID,
          })
          lastAssistant.finish = "stop"
          await Session.updateMessage(lastAssistant)
          break
        }

        // User-requested empty-response recovery (2026-05-08): on any
        // real empty turn, reset the codex response chain unconditionally.
        // Drops `lastResponseId` for every per-account shard of this
        // session, so the next outbound request omits previous_response_id
        // and the server rebuilds the chain from our locally-stored full
        // conversation. Local context untouched — equivalent to "close WS
        // ID and reconnect with same messages" but without an actual
        // socket bounce (codex transport's chain identity is the response
        // ID, not the connection).
        //
        // 2026-05-12 (Phase B of session/rebind-procedure-revision):
        // dispatched through Continuation.run so the next outbound also
        // carries a chain_init_notice fragment with commitment digest.
        // This was the documented failure mode behind the 2026-05-12
        // ses_1e56ed3f9ffebv4AaWOlcPLz20 read-loop incident: chain was
        // being reset silently without any AI-visible marker, leaving
        // the model in a "I might have to redo things" reasoning state.
        // The new run() path captures digest BEFORE invalidation (DD-8),
        // marks the next outbound for chain-init injection, and emits
        // chain.commitment.captured + chain.init.injected telemetry.
        // For SL providers (anthropic / gemini) the classifier returns
        // breaksChain=false and the call is a no-op aside from epoch
        // bump — preserving the prior "no-op for non-codex" invariant.
        const { Continuation } = await import("./continuation/run")
        if (failureKindForChainInit === "backend_failure_forced_resend") {
          await Continuation.run({
            kind: "backend_failure_forced_resend",
            sessionID,
            // Map finish=error to classifier=server_failed per the SSE
            // mapping table documented above. Other classifiers
            // (ws_truncation / ws_no_frames / server_incomplete) flow
            // through the empty_response_recovery branch below.
            classifier: "server_failed",
            providerId: lastAssistant.providerId,
          }).catch((err) => {
            log.warn("backend-failure: Continuation.run threw at outer boundary", {
              sessionID,
              step,
              error: err instanceof Error ? err.message : String(err),
            })
          })
          log.info("backend-failure: reset codex continuation chain via Continuation.run", {
            sessionID,
            step,
            classifier: "server_failed",
            emptyRounds: emptyRoundCount,
          })
        } else {
          await Continuation.run({
            kind: "empty_response_recovery",
            sessionID,
            emptyRoundCount,
            providerId: lastAssistant.providerId,
          }).catch((err) => {
            // Continuation.run is already best-effort internally (each
            // step is try/wrapped). Outermost catch here is belt-and-
            // suspenders for any import / synchronous-throw case so the
            // self-heal flow below still runs.
            log.warn("empty-response: Continuation.run threw at outer boundary", {
              sessionID,
              step,
              error: err instanceof Error ? err.message : String(err),
            })
          })
          log.info("empty-response: reset codex continuation chain via Continuation.run", {
            sessionID,
            step,
            emptyRounds: emptyRoundCount,
          })
        }

        // 2026-05-18: empty-response compaction REMOVED.
        // Empty response ≠ context overflow. The original 2026-05-01
        // assumption ("dominant cause is silent server-side context
        // overflow") was wrong — empty responses come from ws_truncation,
        // server_failed, model burps, etc. Real overflow is handled by
        // deriveObservedCondition which uses actual token counts. The
        // removed block fired compaction on empty response + overflowSuspected,
        // but even that gate couldn't prevent floods: the chain reset
        // (already done above via Continuation.run) is sufficient for
        // chain corruption; compaction adds nothing for transport failures.
        //
        // Recovery path: chain reset (above) + natural stop (below).
        // If the context IS actually overflowing, deriveObservedCondition
        // will fire compaction on the NEXT iteration using real token
        // pressure signals — not the empty-response heuristic.
        log.warn("empty-response: chain reset done, closing as natural stop", {
          sessionID,
          emptyRounds: emptyRoundCount,
          step,
          isSubagent: !!session.parentID,
        })
        lastAssistant.finish = "stop"
        await Session.updateMessage(lastAssistant)
        break
      }

      // Tool-call paralysis detectors. Two-turn match → warn (early signal).
      // Three-turn match → break the loop with ParalysisDetectedError so the
      // user gets a stop signal instead of an unbounded retreat-narrative
      // burn. Re-armed 2026-05-08 after observing 5694-round loop on a codex
      // session whose narrative repetition went undetected (Detector B used
      // to look at "text" parts only; codex emits the short summary on the
      // "reasoning" channel since 5b5e04201).
      //
      //   Detector A — exact tool-call signature repetition.
      //   Detector B — narrative-only repetition (similar leading text).
      if (lastAssistant?.finish === "tool-calls" && lastAssistant.id > lastUser.id) {
        const recentAssistants: MessageV2.WithParts[] = []
        for (let i = msgs.length - 1; i >= 0 && recentAssistants.length < 3; i--) {
          if (msgs[i].info.role === "assistant") {
            const a = msgs[i].info as MessageV2.Assistant
            if (a.finish === "tool-calls" && (a.tokens.input > 0 || a.tokens.output > 0)) {
              recentAssistants.push(msgs[i])
            }
          }
        }

        // Signature must reflect the *whole* tool input, not a prefix.
        // Earlier versions sliced to 200 chars, which collapsed bash calls
        // that share a long boilerplate prefix (e.g. `command -v python3 …
        // PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY' …`) into a single
        // signature even when their heredoc bodies were entirely different.
        // Hash the full JSON instead so genuinely distinct calls hash apart.
        const sigOf = (m: MessageV2.WithParts): string => {
          const tools = m.parts.filter((p) => p.type === "tool")
          return tools
            .map((p) => {
              const tp = p as MessageV2.ToolPart
              const input = (tp.state as { input?: unknown })?.input
              const inputStr = input ? JSON.stringify(input) : ""
              const inputHash = inputStr ? Bun.hash.xxHash64(inputStr).toString(16) : ""
              return `${tp.tool}:${inputHash}`
            })
            .join("|")
        }
        // Pull narrative text from a real text part, falling back to the
        // last reasoning part — codex provider routes the short summary
        // ("我會先停止...") through reasoning since 5b5e04201, so without
        // this fallback Detector B silently sees empty strings on codex
        // sessions and never fires.
        const leadingText = (m: MessageV2.WithParts): string => {
          const textPart = m.parts.find((p) => p.type === "text" && !(p as { synthetic?: boolean }).synthetic) as
            | { text?: string }
            | undefined
          let raw = textPart?.text ?? ""
          if (!raw) {
            const reasoningParts = m.parts.filter((p) => p.type === "reasoning") as Array<{ text?: string }>
            const last = reasoningParts[reasoningParts.length - 1]
            raw = last?.text ?? ""
          }
          return raw.toLowerCase().replace(/\s+/g, "").slice(0, 600)
        }
        const bigrams = (s: string): Set<string> => {
          const out = new Set<string>()
          for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
          return out
        }
        const jaccard = (a: Set<string>, b: Set<string>): number => {
          if (a.size === 0 || b.size === 0) return 0
          let inter = 0
          for (const x of a) if (b.has(x)) inter++
          return inter / (a.size + b.size - inter)
        }

        const sigs = recentAssistants.map(sigOf)
        const texts = recentAssistants.map(leadingText)

        const sigPairsMatch = (a: number, b: number): boolean => !!sigs[a] && sigs[a] === sigs[b]
        const narrativePairsMatch = (a: number, b: number): number => {
          if (texts[a].length < 60 || texts[b].length < 60) return 0
          return jaccard(bigrams(texts[a]), bigrams(texts[b]))
        }

        // 2-turn warn (early signal).
        if (recentAssistants.length >= 2) {
          if (sigPairsMatch(0, 1)) {
            const repeatedTool = recentAssistants[0].parts
              .filter((p) => p.type === "tool")
              .map((p) => (p as MessageV2.ToolPart).tool)[0]
            log.warn("paralysis-observe: tool-call signature repeated", {
              sessionID,
              step,
              signature: sigs[0].slice(0, 200),
              repeatedTool,
            })
          }
          const j01 = narrativePairsMatch(0, 1)
          if (j01 > 0.5) {
            log.warn("paralysis-observe: narrative repetition", {
              sessionID,
              step,
              similarity01: j01.toFixed(2),
              samplePrefix: texts[0].slice(0, 120),
            })
          }
        }

        // Detector C — self-narrated stuck phrase. When the model itself
        // says "Duplicate ...", "Need stop", "stop using duplicate", etc.
        // in 2 consecutive turns AND the tool-call signature also matches,
        // we have very high confidence it's stuck. Fire recovery
        // immediately at 2-turn instead of waiting for 3-turn — user only
        // sees at most 1 self-narrated warning before silent recovery.
        //
        // 2026-05-08: observed empirical pattern — gpt-5.5 in degraded
        // tool-repeat mode emits telegraphic English self-warnings
        // ("Duplicate todowrite due accidental. Need continue. Need use
        // attachment.") in the reasoning channel. These phrases are a
        // strong "I know I'm stuck but can't escape" signal — the model
        // has self-awareness but no path out. Triggering recovery at
        // 2-turn here gets ahead of the user-visible 3rd warning.
        //
        // Phrase-match alone is not enough (false positives if user asks
        // about deduplication etc.); it must coincide with an actual
        // signature OR narrative repetition.
        const STUCK_PHRASES = /\b(duplicate(?:d)?|need stop|stop using|repeating|loop(?:ed|ing)?|stuck|no progress)\b/i
        if (recentAssistants.length >= 2 && paralysisRecoveryCount === 0) {
          const stuck0 = STUCK_PHRASES.test(texts[0])
          const stuck1 = STUCK_PHRASES.test(texts[1])
          const sigMatch = sigPairsMatch(0, 1)
          const narrativeMatch = narrativePairsMatch(0, 1) > 0.5
          if (stuck0 && stuck1 && (sigMatch || narrativeMatch)) {
            paralysisRecoveryCount = 1
            log.warn("paralysis-recover: 2-turn self-stuck phrase, injecting nudge", {
              sessionID,
              step,
              detector: "phrase",
              sigMatch,
              narrativeMatch,
              samplePrefix: texts[0].slice(0, 120),
            })
            const nudgeText =
              "你連續 2 輪在 reasoning 寫『duplicate / need stop / stuck』類的自我警告，但還是重複同一個動作。停下來換一條路徑 — 檢查 state、嘗試不同 tool、或直接告訴 user 你卡在哪。"
            const nudgeUser: MessageV2.User = {
              id: Identifier.ascending("message"),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: lastUser.agent,
              model: resolvedModel,
              variant: lastUser.variant,
            }
            await Session.updateMessage(nudgeUser)
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: nudgeUser.id,
              sessionID,
              type: "text",
              text: nudgeText,
              synthetic: true,
            } satisfies MessageV2.TextPart)
            continue
          }
        }

        // 3-turn intervention — auto-recover with one synthetic nudge,
        // hard-break only if recovery itself paralyzes again.
        //
        // 2026-05-08: empirical observation — when paralysis-break fired
        // and the user manually retried (no extra context), the model
        // recovered immediately. The "manual retry" was functionally just
        // "break the runloop, re-enter, model picks up with one extra
        // turn of context." Same idea as empty-response chain reset:
        // interrupt the corrupted local state, retry once, only fail
        // hard if interrupt didn't help. This converts the red toast
        // from a stop sign into a self-heal that's invisible on the
        // happy path.
        if (recentAssistants.length >= 3) {
          const sigTriple = sigPairsMatch(0, 1) && sigPairsMatch(1, 2)
          const j01 = narrativePairsMatch(0, 1)
          const j12 = narrativePairsMatch(1, 2)
          const narrativeTriple = j01 > 0.5 && j12 > 0.5

          if (sigTriple || narrativeTriple) {
            const detector = sigTriple ? "signature" : "narrative"
            const similarity = narrativeTriple ? Math.min(j01, j12) : undefined
            const samplePrefix = narrativeTriple ? texts[0].slice(0, 120) : sigs[0].slice(0, 120)

            // Bloated-input compaction comes BEFORE the recoveryCount gate.
            // A nudge can't drain a 500-item conversation — only compaction
            // can. Previously this check was nested inside `recoveryCount === 0`,
            // so a 2nd paralysis after a no-op nudge bypassed compaction and
            // halted on a still-growing item array. Now: any paralysis triple
            // with items > threshold attempts compaction first; nudge / halt
            // only run when items are not bloated.
            const PARALYSIS_ITEMCOUNT_COMPACT_THRESHOLD = 250
            const estimatedItemCount = (() => {
              let count = 0
              for (const m of msgs) {
                if (m.info.role === "user") {
                  count += 1
                  continue
                }
                if (m.info.role === "assistant") {
                  const hasText = m.parts.some(
                    (p) =>
                      p.type === "text" &&
                      typeof (p as { text?: string }).text === "string" &&
                      ((p as { text: string }).text.length ?? 0) > 0,
                  )
                  if (hasText) count += 1
                  for (const p of m.parts) {
                    if (p.type !== "tool") continue
                    count += 1
                    const status = (p as MessageV2.ToolPart).state?.status
                    if (status === "completed" || status === "error") count += 1
                  }
                }
              }
              return count
            })()

            if (estimatedItemCount > PARALYSIS_ITEMCOUNT_COMPACT_THRESHOLD && !session.parentID) {
              log.warn("paralysis-recover: bloated input, triggering overflow compaction instead of nudge/halt", {
                sessionID,
                step,
                detector,
                similarity,
                estimatedItemCount,
                threshold: PARALYSIS_ITEMCOUNT_COMPACT_THRESHOLD,
                priorRecoveryCount: paralysisRecoveryCount,
              })
              try {
                await SessionCompaction.run({
                  sessionID,
                  observed: "overflow",
                  step,
                  abort,
                })
                // Compaction succeeded: reset recovery counter so a future
                // post-compaction paralysis (under the new, smaller context)
                // gets its own first-paralysis nudge before halting.
                paralysisRecoveryCount = 0
                continue
              } catch (err) {
                log.warn("paralysis-recover: compaction failed, falling through to nudge/halt", {
                  sessionID,
                  step,
                  error: err instanceof Error ? err.message : String(err),
                })
                // fall through to recoveryCount-based nudge/halt
              }
            }

            if (paralysisRecoveryCount === 0) {
              // First detection — auto-inject a synthetic nudge that
              // names the failure mode. Pure "?" (empty-response style)
              // is too cryptic for paralysis: model may interpret it as
              // "say what?" and re-emit the same plan. An explicit
              // "you repeated, try different" is concrete enough to
              // break attention pattern without prescribing the answer.
              paralysisRecoveryCount = 1
              log.warn("paralysis-recover: 3-turn repetition, injecting nudge", {
                sessionID,
                step,
                detector,
                similarity,
                samplePrefix,
              })
              const nudgeText =
                detector === "signature"
                  ? "你連續 3 輪呼叫了同一個 tool 加同樣參數。停下來想想：是不是該檢查當前實際狀態，而不是重複 plan？換一個動作。"
                  : "你連續 3 輪講了非常相似的計畫但沒實際前進。停下來換一條路徑 — 檢查 state、嘗試不同 tool、或直接告訴 user 你卡在哪。"
              const nudgeUser: MessageV2.User = {
                id: Identifier.ascending("message"),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: lastUser.agent,
                model: resolvedModel,
                variant: lastUser.variant,
              }
              await Session.updateMessage(nudgeUser)
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: nudgeUser.id,
                sessionID,
                type: "text",
                text: nudgeText,
                synthetic: true,
              } satisfies MessageV2.TextPart)
              continue
            }

            // Recovery already attempted once and the model still
            // produced 3 identical turns. This is a real stuck state —
            // hard-break with error so the user knows.
            log.warn("paralysis-break: 3-turn repetition AFTER nudge, halting loop", {
              sessionID,
              step,
              detector,
              similarity,
              samplePrefix,
              recoveryAttempts: paralysisRecoveryCount,
            })
            lastAssistant.error = new MessageV2.ParalysisDetectedError({
              message:
                detector === "signature"
                  ? "Loop halted: 3 consecutive turns issued the same tool call EVEN AFTER a recovery nudge. The model is genuinely stuck — review the situation and resume manually."
                  : "Loop halted: 3 consecutive turns repeated the same narrative EVEN AFTER a recovery nudge. The model is genuinely stuck — review and resume manually.",
              detector,
              consecutiveRounds: 3,
              similarity,
              samplePrefix,
            }).toObject()
            lastAssistant.finish = "error"
            await Session.updateMessage(lastAssistant)
            break
          }
          // No triple this iteration — clear recovery counter so a
          // future independent paralysis episode gets its own nudge.
          if (paralysisRecoveryCount > 0) {
            log.info("paralysis-recover: cleared after non-paralyzed turn", {
              sessionID,
              step,
              priorRecoveryCount: paralysisRecoveryCount,
            })
            paralysisRecoveryCount = 0
          }
        }
      }

      if (
        lastAssistant?.finish &&
        !["tool-calls", "unknown", "other"].includes(lastAssistant.finish) &&
        lastUser.id < lastAssistant.id &&
        !hasSubagentCompletion
      ) {
        if (
          format.type === "json_schema" &&
          lastAssistant.structured === undefined &&
          !lastAssistant.error &&
          !["tool-calls", "unknown", "other"].includes(lastAssistant.finish)
        ) {
          lastAssistant.error = new MessageV2.StructuredOutputError({
            message: "Model did not produce structured output",
            retries: 0,
          }).toObject()
          await Session.updateMessage(lastAssistant)
        }
        // Phase 13.1: TurnSummary capture removed. Turn summaries are
        // now derived at read time by `Memory.read(sid)` scanning the
        // messages stream — no separate persistence needed.
        log.info("exiting loop", { sessionID })
        break
      }

      step++
      if (step === 1)
        ensureTitle({
          session,
          modelID: resolvedModel.modelID,
          providerId: resolvedModel.providerId,
          history: msgs,
        })

      // Respect session's pinned execution identity (set by rotation3d after rate-limit fallback).
      // Without this, each tool-loop iteration re-resolves to the original (rate-limited) model,
      // causing a retry storm as rotation fires on every iteration.
      const sessionExec = step > 1 ? (await Session.get(sessionID).catch(() => undefined))?.execution : undefined
      const effectiveProviderId = sessionExec?.providerId ?? resolvedModel.providerId
      const effectiveModelID = sessionExec?.modelID ?? resolvedModel.modelID
      const effectiveAccountId = sessionExec?.accountId ?? resolvedModel.accountId
      const model = await Provider.getModel(effectiveProviderId, effectiveModelID).catch((e) => {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({
              message: `Model not found: ${e.data.providerId}/${e.data.modelID}.${hint}`,
            }).toObject(),
          })
        }
        throw e
      })

      if (step === 1 && !session.parentID) {
        // Phase 13.2: rebind recovery via stream-anchor scan only. The
        // messages stream is the single source of truth — no disk
        // checkpoint file. The anchor message itself contains the compacted
        // summary text; slice from there onward to drop pre-anchor history
        // that the resumed session no longer needs as live context.
        try {
          const before = msgs.length
          const result = applyStreamAnchorRebind(msgs)
          const shouldRefreshRebindTokens =
            result.applied || result.reason === "no_anchor" || result.reason === "unsafe_boundary"
          let refreshedInputTokens = shouldRefreshRebindTokens ? estimateMsgsTokenCount(msgs) : undefined
          if (result.applied) {
            msgs = result.messages
            refreshedInputTokens = estimateMsgsTokenCount(msgs)
            // Refresh lastFinished.tokens.input so the state-driven
            // evaluator below sees the RECONSTRUCTED prompt size, not the
            // pre-rebind assistant message's stale `tokens.input`.
            if (lastFinished) {
              lastFinished = {
                ...lastFinished,
                tokens: { ...lastFinished.tokens, input: refreshedInputTokens ?? lastFinished.tokens.input },
              }
            }
            debugCheckpoint("prompt", "loop:rebind_stream_anchor_applied", {
              sessionID,
              step,
              anchorMessageId: msgs[0]?.info.id,
              messagesBefore: before,
              messagesAfter: msgs.length,
              reconstructedTokens: lastFinished?.tokens?.input,
            })
            log.info("rebind from stream anchor", {
              sessionID,
              anchorMessageId: msgs[0]?.info.id,
              messageCount: msgs.length,
              reconstructedTokens: lastFinished?.tokens?.input,
            })
          } else if (result.reason === "unsafe_boundary") {
            if (lastFinished && refreshedInputTokens !== undefined) {
              lastFinished = {
                ...lastFinished,
                tokens: { ...lastFinished.tokens, input: refreshedInputTokens },
              }
            }
            log.warn("rebind skipped: unsafe boundary at first post-anchor message", {
              sessionID,
              anchorIndex: result.anchorIndex,
              refreshedInputTokens,
            })
          } else if (result.reason === "no_anchor") {
            if (lastFinished && refreshedInputTokens !== undefined) {
              lastFinished = {
                ...lastFinished,
                tokens: { ...lastFinished.tokens, input: refreshedInputTokens },
              }
            }
          }
          // result.reason === "no_anchor" is the common case for fresh sessions
          // — silent no-op.
        } catch (error) {
          log.warn("failed to apply stream-anchor rebind", { sessionID, error: String(error) })
        }

        // 2026-05-09: pre-emptive compaction at rebind handoff.
        //
        // Daemon restart resets state.lastResponseId for every session.
        // The very first request after restart MUST send the full input
        // array (chain reset, no incremental delta). If sqlite holds a
        // bloated session — itemCount past codex backend's hidden bug
        // zone, OR tokens past 70% of context — that first request is
        // pre-doomed to ws_truncation / server_failed. The reactive
        // ws-truncation × bloated-input trigger eventually rescues, but
        // pays one full failed request first.
        //
        // Pre-emptive: at step=1 right after applyStreamAnchorRebind,
        // estimate itemCount + tokens from the sliced msgs. If either
        // is heavy → run local compaction BEFORE opening the WS
        // connection. Next iteration of the runloop sees a fresh anchor,
        // sliced input is small, the WS request goes out clean.
        //
        // Healthy / freshly-anchored sessions skip naturally (items
        // already low after slice, tokens below threshold).
        const REBIND_PREEMPT_ITEM_THRESHOLD = 250
        const REBIND_PREEMPT_TOKEN_RATIO = 0.8
        try {
          let estimatedItemCount = 0
          for (const m of msgs) {
            if (m.info.role === "user") {
              estimatedItemCount += 1
              continue
            }
            if (m.info.role === "assistant") {
              const hasText = m.parts.some(
                (p) =>
                  p.type === "text" &&
                  typeof (p as { text?: string }).text === "string" &&
                  ((p as { text: string }).text.length ?? 0) > 0,
              )
              if (hasText) estimatedItemCount += 1
              for (const p of m.parts) {
                if (p.type !== "tool") continue
                estimatedItemCount += 1
                const status = (p as MessageV2.ToolPart).state?.status
                if (status === "completed" || status === "error") estimatedItemCount += 1
              }
            }
          }
          const lastFinishedTokens = lastFinished?.tokens?.total ?? 0
          const tokenLimit = resolvedModel
            ? ((await Provider.getModel(resolvedModel.providerId, resolvedModel.modelID).catch(() => undefined))?.limit
                ?.context ?? 0)
            : 0
          const tokenRatio = tokenLimit > 0 ? lastFinishedTokens / tokenLimit : 0
          const tokensHeavy = tokenRatio > REBIND_PREEMPT_TOKEN_RATIO
          if (tokensHeavy) {
            log.warn("rebind handed off bloated session, pre-emptive compaction before WS open", {
              sessionID,
              step,
              estimatedItemCount,
              tokensHeavy,
              tokenRatio: Number(tokenRatio.toFixed(3)),
              tokenLimit,
            })
            try {
              await SessionCompaction.run({
                sessionID,
                observed: "rebind",
                step,
                abort,
              })
              continue
            } catch (err) {
              log.warn("rebind pre-emptive compaction failed, falling through to live request", {
                sessionID,
                step,
                error: err instanceof Error ? err.message : String(err),
              })
              // fall through; the reactive ws-truncation × bloated-input
              // trigger will catch the failure on the next iteration.
            }
          }
        } catch (err) {
          log.warn("rebind pre-emptive evaluation threw", {
            sessionID,
            step,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const task = tasks.pop()
      // pending subtask (invocation routed via ToolInvoker)
      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const taskModel = task.model ? await Provider.getModel(task.model.providerId, task.model.modelID) : model
        const sessionExecution = (await Session.get(sessionID).catch(() => undefined))?.execution
        const taskAccountId =
          task.model?.providerId === (sessionExecution?.providerId ?? resolvedModel.providerId)
            ? (sessionExecution?.accountId ?? resolvedModel.accountId)
            : task.model?.accountId
        const assistantMessage = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: taskModel.id,
          providerId: taskModel.providerId,
          accountId: taskAccountId,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        const taskPromptInput = task.prompt_input ?? task.prompt
        let part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: taskPromptInput,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
              model: task.model ? `${task.model.providerId}/${task.model.modelID}` : undefined,
              account_id: taskAccountId,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        let executionError: Error | undefined
        const taskAgent = await Agent.get(task.agent)
        const result = await ToolInvoker.execute(TaskTool, {
          sessionID,
          messageID: assistantMessage.id,
          toolID: TaskTool.id,
          args: {
            prompt: taskPromptInput,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
            model: task.model ? `${task.model.providerId}/${task.model.modelID}` : undefined,
            account_id: taskAccountId,
          },
          agent: task.agent,
          abort,
          messages: msgs,
          extra: { bypassAgentCheck: true },
          callID: part.callID,
          onMetadata: async (val) => {
            // Persist metadata (including child sessionId) so frontend can render SubagentActivityCard
            if (part.state.status === "running") {
              part = (await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  title: val.title,
                  metadata: val.metadata,
                },
              })) as MessageV2.ToolPart
            }
          },
          onAsk: async (req) => {
            await PermissionNext.ask({
              ...req,
              sessionID: sessionID,
              ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }).catch((error) => {
          executionError = error
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        if (result && part.state.status === "running") {
          const attachments = materializeToolAttachments(result.attachments, {
            messageID: assistantMessage.id,
            sessionID: assistantMessage.sessionID,
          })
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.metadata,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (task.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          const summaryUserMsg: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            time: {
              created: Date.now(),
            },
            agent: lastUser.agent,
            model: resolvedModel,
            variant: lastUser.variant,
          }
          await Session.updateMessage(summaryUserMsg)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: "Summarize the task tool output above and continue with your task.",
            synthetic: true,
          } satisfies MessageV2.TextPart)
        }

        continue
      }

      // ── compaction-redesign — state-driven evaluation (DD-1) ──────────
      // Each runloop iteration re-evaluates whether compaction is warranted
      // from current observable state (cooldown anchor, pinned identity vs
      // most recent Anchor's identity, current msgs token estimate,
      // message-stream tail, session.execution.continuationInvalidatedAt).
      // No flags persisted across iterations. If deriveObservedCondition
      // returns non-null, route through SessionCompaction.run; on "continue"
      // skip the rest of this iteration's body, on "stop" carry on without
      // compacting this round.
      //
      // Phase 13 hotfix: tokens for isOverflow / isCacheAware come from
      // `estimateMsgsTokenCount(msgs)` — the SIZE OF THE PROMPT WE'RE ABOUT
      // TO SEND — not from `lastFinished.tokens.input` (the previous LLM
      // call's actual input, which is stale once tool results have been
      // appended this iteration). Without this, a tool that returns a huge
      // text blob (e.g. system-manager_read_subsession dumping a whole
      // session transcript) inflates the about-to-send prompt by 100K+ in
      // one step while lastFinished still reports the pre-tool-output
      // figure — overflow check misses, request goes out, provider rejects.
      // We take the max of (estimated, lastFinished.tokens.input) so cache
      // counters from lastFinished are preserved when it's the larger
      // signal.
      const sessionExecForCompaction = (await Session.get(sessionID).catch(() => undefined))?.execution
      const promptInputEstimate = estimateMsgsTokenCount(msgs)
      const overflowInputTokens = Math.max(promptInputEstimate, lastFinished?.tokens?.input ?? 0)
      const overflowTokens = lastFinished
        ? { ...lastFinished.tokens, input: overflowInputTokens }
        : ({
            input: overflowInputTokens,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          } as MessageV2.Assistant["tokens"])
      const observed = await deriveObservedCondition({
        sessionID,
        step,
        msgs,
        lastFinished,
        pinnedProviderId: effectiveProviderId,
        pinnedAccountId: effectiveAccountId ?? undefined,
        hasUnprocessedCompactionRequest: task?.type === "compaction-request",
        compactionRequestAuto: task?.type === "compaction-request" ? task.auto : undefined,
        parentID: session.parentID,
        continuationInvalidatedAt: sessionExecForCompaction?.continuationInvalidatedAt,
        predictedCacheMiss: sessionExecForCompaction?.continuationInvalidatedAt ? "miss" : "unknown",
        currentInputTokens: overflowInputTokens,
        modelContextWindow: model.limit.input ?? model.limit.context,
        isOverflow: () =>
          SessionCompaction.isOverflow({
            tokens: overflowTokens,
            model,
            sessionID,
            currentRound: step,
          }),
        isCacheAware: () =>
          SessionCompaction.shouldCacheAwareCompact({
            tokens: overflowTokens,
            model,
            sessionID,
            currentRound: step,
          }),
      })
      emitCompactionPredicateTelemetry({
        sessionID,
        step,
        outcome: observed ? "fire" : "none",
        reason: observed ? "observed_condition" : "no_predicate_matched",
        observed,
        currentInputTokens: overflowInputTokens,
        modelContextWindow: model.limit.input ?? model.limit.context,
        predictedCacheMiss: sessionExecForCompaction?.continuationInvalidatedAt ? "miss" : "unknown",
        hasLastFinished: !!lastFinished,
        hasCompactionRequest: task?.type === "compaction-request",
        isSubagent: !!session.parentID,
      })

      if (observed) {
        debugCheckpoint("prompt", "loop:state_driven_compaction", {
          sessionID,
          step,
          observed,
        })
        const result = await SessionCompaction.run({
          sessionID,
          observed,
          step,
          intent: task?.type === "compaction-request" && task.auto === false ? "default" : "default",
          abort,
        })
        if (result === "continue") {
          continue
        }
        // result === "stop": chain exhausted (rare — only when llm-agent
        // itself fails, e.g. canSummarize=false on a tiny model). Carry on
        // to the next iteration without compacting; future iterations
        // re-evaluate.
        debugCheckpoint("prompt", "loop:state_driven_compaction_chain_exhausted", {
          sessionID,
          step,
          observed,
        })
      }

      // ── Phase 7: legacy compaction branches deleted ──
      // Previous behaviour was a transitional bridge (phase 6) where new
      // state-driven path was tried first and legacy was the fallback. With
      // phase 7b's tryLlmAgent in place, the new chain handles every case
      // the legacy branches did. The branches are gone; if run() returns
      // "stop", the runloop simply continues without compacting this round.
      // Next iteration re-evaluates from observable state.

      // Phase 13.2: rebind disk-file checkpoint write removed. The anchor
      // message itself (written by compactWithSharedContext when compaction
      // succeeds) is the durable record. Stream-anchor scan at restart
      // recovers the same context without a separate file.

      // normal processing
      const userMsg = msgs.findLast((m) => m.info.role === "user")
      const imageResolution = await resolveImageRequest({
        model,
        accountId: resolvedModel.accountId,
        message: userMsg,
        sessionID,
      })
      const activeModel = imageResolution.model
      if (imageResolution.rotated) {
        const change = `${activeModel.providerId}/${activeModel.id}`
        publishToastTraced(
          {
            title: "Model Rotated",
            message: `Using ${change} for image input`,
            variant: "info",
            duration: 4000,
            scope: "session",
          },
          { source: "prompt.imageRouter.rotated" },
        ).catch(() => {})

        // PERSISTENCE: Update the user message to use this working model as the preference.
        // This ensures subsequent turns (which check `lastModel`) will default to this capability-verified model.
        if (lastUser) {
          const updatedInfo = { ...lastUser }
          updatedInfo.model = {
            providerId: activeModel.providerId,
            modelID: activeModel.id,
            accountId: resolvedModel.accountId,
          }
          await Session.updateMessage(updatedInfo)
        }

        // SSOT: pin session execution to the image-capable model so UI (footer,
        // selector, quota) reflects what the next LLM call will actually use.
        // Without this, processor's preflight pin is skipped (session already
        // has an account pinned) and UI shows the pre-rotation model.
        await Session.pinExecutionIdentity({
          sessionID,
          model: {
            providerId: activeModel.providerId,
            modelID: activeModel.id,
            accountId: lastUser?.model?.accountId,
          },
        }).catch((err) => {
          log.warn("image-router: failed to pin execution identity", {
            sessionID,
            providerId: activeModel.providerId,
            modelID: activeModel.id,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
      const agent = await Agent.get(lastUser.agent)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
      })

      // DIAG 2026-04-30: pre-LLM-call msgs snapshot. Pairs with [CODEX-WS] REQ
      // tail to verify the model is being fed monotone-growing chronological
      // context. If msgs.length isn't growing turn-over-turn, or the tail
      // doesn't include the most recent assistant attempt, the model can't
      // see its own loop and just keeps re-trying.
      log.info("diag.preLLM", {
        sessionID,
        step,
        msgsLen: msgs.length,
        tail: msgs.slice(-3).map((m) => {
          const info = m.info as MessageV2.Info & { finish?: string }
          const textPart = m.parts.find((p) => p.type === "text") as { text?: string } | undefined
          return {
            id: info.id,
            role: info.role,
            t: (info as { time?: { created?: number } }).time?.created,
            finish: (info as { finish?: string }).finish ?? null,
            preview: (textPart?.text ?? "").slice(0, 80),
          }
        }),
      })

      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: Identifier.ascending("message"),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: activeModel.id,
          providerId: activeModel.providerId,
          accountId: effectiveAccountId,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model: activeModel,
        accountId: effectiveAccountId,
        abort,
      })
      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      // Stream-idle watchdog rendezvous box (plans/question-tool_idle-watchdog-false-kill DD-1).
      // Created here, shared by reference with both resolveTools (which
      // wires it into per-tool ctx via lazy lookup) and LLM.stream via
      // processor.process below (which populates `.pause` once the
      // watchdog exists). Same reference on both sides — that's what
      // makes the lazy lookup in resolve-tools.ts see the live function.
      const idleWatchdogBox: { pause?: () => () => void } = {}

      const resolvedToolsOutput = await resolveTools({
        agent,
        session,
        model: activeModel,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
        idleWatchdogBox,
      })

      const tools = resolvedToolsOutput.tools
      const lazyTools = resolvedToolsOutput.lazyTools
      const lazyCatalogPrompt = resolvedToolsOutput.lazyCatalogPrompt

      // Active Loader: lazy tools are NOT injected into the tools dict.
      // They are passed separately via `lazyTools` to the processor/LLM,
      // which handles on-demand unlock via experimental_repairToolCall.
      // A compact catalog prompt is injected as a system message so the AI
      // knows what deferred tools exist and can call them directly.

      if (format.type === "json_schema") {
        tools["StructuredOutput"] = createStructuredOutputTool({
          schema: format.schema,
          onSuccess(output) {
            structuredOutput = output
          },
        })
      }

      // Forced reader gate: when the conversation has any attachment_ref part
      // that has not yet been read by the `attachment` tool, clamp this turn to
      // the attachment tool with toolChoice="required" so the main agent must
      // dispatch a reader subagent before doing anything else. The agent gets
      // to see the user's full prompt + ref metadata, so it can craft the
      // question; what it cannot do is skip the dispatch or hallucinate the
      // contents. Skipped during structured-output mode (json_schema owns
      // toolChoice) and on subagent sessions (the parent already gated).
      const forcedReadGate =
        !session.parentID && format.type !== "json_schema" && hasUnreadAttachmentRefs(msgs) && !!tools["attachment"]
      const gatedTools = forcedReadGate ? { attachment: tools["attachment"] } : tools
      const gatedLazyTools = forcedReadGate ? new Map<string, AITool>() : lazyTools
      const gatedLazyCatalogPrompt = forcedReadGate ? undefined : lazyCatalogPrompt
      const gatedToolChoice: "auto" | "required" | "none" | undefined = forcedReadGate
        ? "required"
        : format.type === "json_schema"
          ? "required"
          : undefined

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
      }

      let sessionMessages = clone(msgs)
      if (imageResolution.dropImages) {
        stripImageParts(sessionMessages)
      }

      // compaction-fix Phase 1 — post-anchor tail transformer (DD-1..DD-7).
      // Folds completed assistant turns beyond `recentRawRounds` into a
      // single trace marker text part so `inputItemCount` stays clear of
      // codex backend's array-length sensitivity (>~300 items failure
      // region observed in fix-empty-response-rca soak).
      //
      // DD-5: subagent path bypass — sub-sessions inherit parent context
      // unchanged in Phase 1; only main sessions are transformed.
      // DD-4: safety net — if transform shrinks below the configured
      // floor (defensive against unusual session shapes), fall back to
      // raw and warn.
      // DD-6: feature flag default false; enable via tweaks.cfg
      // `compaction_phase1_enabled = 1` for gradual rollout.
      const compactionTweakPhase1 = Tweaks.compactionSync()
      const dialogRedactionEnabled =
        (compactionTweakPhase1 as { enableDialogRedactionAnchor?: boolean }).enableDialogRedactionAnchor !== false
      // dialog-replay-redaction (M3): v7 redacts tool outputs to recall_id
      // markers; runs by default for both main and subagent sessions
      // because the redact-only logic preserves all messages and is safe
      // under any session shape. v6 (drop-based) remains gated by
      // phase1Enabled + main-session-only since it changes message count.
      const runV7 = dialogRedactionEnabled
      const runV6 = !dialogRedactionEnabled && compactionTweakPhase1.phase1Enabled && !session.parentID
      if (runV7 || runV6) {
        try {
          const beforeCount = sessionMessages.length
          const beforeParts = sessionMessages.reduce((sum, m) => sum + m.parts.length, 0)
          const transformed = transformPostAnchorTail(sessionMessages)
          if (runV6 && transformed.messages.length < compactionTweakPhase1.fallbackThreshold) {
            log.warn("phase1-transform: fallback to raw", {
              sessionID,
              step,
              threshold: compactionTweakPhase1.fallbackThreshold,
              got: transformed.messages.length,
              transformedTurnCount: transformed.transformedTurnCount,
            })
          } else if (transformed.transformedTurnCount > 0 || (transformed.redactedToolPartCount ?? 0) > 0) {
            sessionMessages = transformed.messages
            const afterParts = sessionMessages.reduce((sum, m) => sum + m.parts.length, 0)
            log.info("post-anchor-transform: applied", {
              sessionID,
              step,
              version: runV7 ? "v7" : "v6",
              transformedTurns: transformed.transformedTurnCount,
              exemptTurns: transformed.exemptTurnCount,
              redactedToolParts: transformed.redactedToolPartCount ?? 0,
              partsBefore: beforeParts,
              partsAfter: afterParts,
              messagesCount: beforeCount,
            })
          }
        } catch (err) {
          if (err instanceof LayerPurityViolation) {
            log.error("post-anchor-transform: layer purity violation", {
              sessionID,
              step,
              forbiddenKey: err.forbiddenKey,
              context: err.context,
            })
            // Re-throw — architectural invariant breach surfaces upward.
            throw err
          }
          log.warn("post-anchor-transform: unexpected error, falling back to raw", {
            sessionID,
            step,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // compaction-fix Phase 2 — encrypted anchor prefix injection.
      //
      // When the anchor carries codex-issued `serverCompactedItems` bound
      // to the current execution chain, pass them directly to the codex
      // provider via the process-level compacted-items-store. The provider
      // prepends them as raw ResponseItem[] to input[], bypassing the
      // LMv2→ResponseItem text conversion. The anchor message is dropped
      // from sessionMessages (its context is in the encrypted blob);
      // post-anchor tail messages continue through the normal pipeline.
      //
      // Non-codex providers and chain-mismatch cases: leave messages as-is
      // (narrative body flows through the normal text pipeline).
      if (compactionTweakPhase1.phase2Enabled && !session.parentID) {
        try {
          const phase2Result = expandAnchorCompactedPrefix(sessionMessages, {
            sessionID,
            accountId: effectiveAccountId,
            modelID: activeModel.id,
          })
          console.error(
            `[PHASE2] applied=${phase2Result.applied} reason=${(phase2Result as any).reason ?? "n/a"} provider=${activeModel.providerId} anchor0Role=${sessionMessages[0]?.info?.role ?? "none"}`,
          )
          if (
            phase2Result.applied &&
            activeModel.providerId === "codex" &&
            (compactionTweakPhase1 as { enableHybridLlm?: boolean }).enableHybridLlm
          ) {
            // Extract raw serverCompactedItems from anchor metadata and
            // store them for the codex provider to consume. Drop anchor
            // from messages — its content is in the encrypted items.
            const anchorMeta = sessionMessages[0]?.parts.find((p: any) => p.type === "compaction")
            const serverItems = (anchorMeta as any)?.metadata?.serverCompactedItems as unknown[] | undefined
            console.error(
              `[PHASE2-CODEX] hasAnchorMeta=${!!anchorMeta} hasServerItems=${!!serverItems} itemCount=${serverItems?.length ?? 0}`,
            )
            if (serverItems && serverItems.length > 0) {
              // ai_free encrypted anchor: store items for codex provider to
              // consume as raw ResponseItem[] prefix. Use require() not
              // dynamic import() — the latter hangs when module path
              // doesn't resolve in the bundle.
              try {
                const { setCompactedItemsPrefix } = require("@opencode-ai/provider-codex/compacted-items-store")
                setCompactedItemsPrefix(sessionID, serverItems)
                sessionMessages = sessionMessages.slice(1) // drop anchor
                log.info("phase2-encrypted-prefix: stored for codex", {
                  sessionID,
                  step,
                  itemCount: serverItems.length,
                  hasEncryptedBlob: serverItems.some((i: any) => (i as any)?.type === "compaction_summary"),
                })
              } catch {
                // Module not available — fall back to synthetic messages
                sessionMessages = phase2Result.messages
                log.warn("phase2-encrypted-prefix: store unavailable, using synthetic fallback", { sessionID, step })
              }
            } else {
              // phase2Result.applied but no raw items — use the expanded
              // synthetic messages as fallback (legacy Phase 2 path).
              sessionMessages = phase2Result.messages
              log.info("phase2-anchor-prefix-expand: applied (synthetic fallback)", {
                sessionID,
                step,
                expandedItemCount: phase2Result.expandedItemCount,
              })
            }
          } else if (phase2Result.applied) {
            // Non-codex provider — use expanded synthetic messages
            sessionMessages = phase2Result.messages
            log.info("phase2-anchor-prefix-expand: applied (non-codex)", {
              sessionID,
              step,
              expandedItemCount: phase2Result.expandedItemCount,
            })
          } else if (phase2Result.reason === "chain-mismatch") {
            log.warn("phase2-anchor-prefix-expand: chain-binding mismatch, falling back to narrative", {
              sessionID,
              step,
              accountId: effectiveAccountId,
              modelID: activeModel.id,
            })
          } else {
            log.debug?.("phase2-anchor-prefix-expand: skipped", {
              sessionID,
              step,
              reason: phase2Result.reason,
            })
          }
        } catch (err) {
          if (err instanceof LayerPurityViolation) {
            log.error("phase2-anchor-prefix-expand: layer purity violation", {
              sessionID,
              step,
              forbiddenKey: err.forbiddenKey,
              context: err.context,
            })
            throw err
          }
          log.warn("phase2-anchor-prefix-expand: unexpected error, falling back", {
            sessionID,
            step,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Ephemerally wrap queued user messages with a reminder to stay on track
      if (step > 1 && lastFinished) {
        for (const msg of sessionMessages) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            part.text = [
              "<system-reminder>",
              "The user sent the following message mid-run:",
              part.text,
              "",
              "Address it and decide how to proceed — continue, adjust, or stop, based on what the user said.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      // Claude proactive reminder (anti-"光說不做"). Mirrors the official Claude
      // Code per-turn isMeta turnReminder, gated to claude + autonomous (autorun
      // opt-in). Appended ephemerally to the tail turn's text — highest recency,
      // right before generation — so it steers this turn without being persisted
      // (sessionMessages is a clone). See CLAUDE_PROACTIVE_REMINDER.
      if (isClaudeContextProvider(activeModel.providerId) && session.workflow?.autonomous.enabled === true) {
        let tailUserText: (typeof sessionMessages)[number]["parts"][number] | undefined
        for (let i = sessionMessages.length - 1; i >= 0 && !tailUserText; i--) {
          if (sessionMessages[i].info.role !== "user") continue
          tailUserText = sessionMessages[i].parts.find((p) => p.type === "text" && !p.ignored && p.text.trim())
        }
        if (tailUserText && tailUserText.type === "text") {
          tailUserText.text = `${tailUserText.text}\n\n${CLAUDE_PROACTIVE_REMINDER}`
          log.info("claude-proactive-reminder.injected", { sessionID, step })
        }
      }

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })

      // Determine if we should load instruction prompts
      // Subagent sessions (parentID set) or subagent modes still need to adhere to the core constitution
      // to ensure consistent behavioral standards (e.g., Read-Before-Write, Absolute Paths).
      const instructionPrompts = cachedInstructionPrompts
      const environmentKey = `${activeModel.providerId}/${activeModel.api.id}`
      let environmentPrompts = environmentCache.get(environmentKey)
      if (!environmentPrompts) {
        environmentPrompts = await SystemPrompt.environment(activeModel, sessionID, session.parentID)
        environmentCache.set(environmentKey, environmentPrompts)
      }
      debugCheckpoint("prompt", "loop:instruction_decision", {
        sessionID,
        parentID: session.parentID,
        agentName: agent.name,
        agentMode: agent.mode,
        instructionCount: instructionPrompts.length,
      })

      // ── Capability layer refresh (session-rebind-capability-refresh) ──
      // DD-15: the existing mandatory-skills hook is now a forwarder onto
      // CapabilityLayer.get. Cache-hit rounds do zero disk I/O; cache-miss
      // (after a rebind event bumps the epoch) triggers the production loader
      // which internally performs resolve + reconcile + preload for skills
      // AND picks up the freshly-read AGENTS.md.
      //
      // Lazy daemon_start bump (Phase 4.1): if this session has never been
      // bumped (epoch=0) — e.g. first round after a fresh daemon — mark it as
      // the implicit daemon_start rebind so the capability-layer cache gets
      // populated at epoch=1 on the next CapabilityLayer.get call.
      try {
        ensureCapabilityLoaderRegistered()
        if (RebindEpoch.current(sessionID) === 0) {
          await RebindEpoch.bumpEpoch({
            sessionID,
            trigger: "daemon_start",
            reason: "first runLoop iteration after daemon start",
          })
        }
        // DD-8: pass current accountId so CapabilityLayer.get can refuse a
        // cross-account fallback. Same-account fallback (transient loader
        // failure) keeps the existing degraded-mode WARN behavior.
        await CapabilityLayer.get(
          sessionID,
          RebindEpoch.current(sessionID),
          session.execution?.accountId ?? lastUser?.model?.accountId,
        )
      } catch (err) {
        // DD-8: cross-account rebind failure is a correctness violation, not
        // a tolerable degraded state. Re-throw to runloop so the user sees
        // an actionable error instead of silently getting stale BIOS bound
        // to a different account's auth/quota/model limits.
        if (err instanceof CrossAccountRebindError) {
          log.error("capability-layer cross-account rebind failed; refusing prompt assembly", {
            sessionID,
            from: err.from,
            to: err.to,
            failures: err.failures,
          })
          throw err
        }
        // Loud warn — AGENTS.md 第一條 prohibits silent fallback for everything
        // else, but transient same-account failures keep the runloop alive.
        log.warn("capability-layer refresh failed (non-fatal, continuing prompt assembly)", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // responsive-orchestrator R2/R6 DD-3: drain pendingSubagentNotices.
      // Each notice becomes a one-line system-prompt addendum so main agent
      // sees subagent results on its very next turn without polluting the
      // visible chat log. Drain is atomic: notices are removed from the
      // session info in the same Session.update pass so they never render
      // twice.
      const pendingNotices = session.pendingSubagentNotices ?? []
      const noticeAddenda: string[] = []
      if (pendingNotices.length > 0) {
        for (const n of pendingNotices) {
          noticeAddenda.push(renderNoticeAddendum(n))
        }
        await Session.update(sessionID, (draft) => {
          // Remove only the notices we consumed — new arrivals between read
          // and write survive.
          const consumed = new Set(pendingNotices.map((n) => n.jobId))
          draft.pendingSubagentNotices = (draft.pendingSubagentNotices ?? []).filter((n) => !consumed.has(n.jobId))
        }).catch(() => undefined)
      }

      // DD-19: the context budget is per-turn-dynamic (used/ratio/cache_read/…)
      // → it MUST ride the uncached preface tail (added to `system` below, which
      // LLM.stream carries into the preface trailing tier), NOT be spliced into a
      // cached conversation message. The old withContextBudgetEnvelope splice put
      // the <context_budget> block into the last user message — inside the cached
      // prefix — so it invalidated the whole conversation cache every turn its
      // numbers changed (the mid-runloop "cache 跑了" colds). Mirrors official,
      // which never splices a mutating value into a cached message. See
      // datasheet.md §2 / DD-18 (volatile → tail).
      const contextBudgetText = await resolveContextBudgetText({
        lastFinished: contextBudgetSource,
        model: activeModel,
      })
      const contextBudget = buildContextBudgetPolicyInput({
        lastFinished: contextBudgetSource,
        model: activeModel,
      })

      // Phase B (specs/prompt-cache-and-compaction-hardening DD-1..DD-16):
      // dynamic content (preload, env date, AGENTS.md) is no longer pre-baked
      // into a single `system` string array. Caller threads structured fields;
      // LLM.stream assembles a static system block + a user-role context
      // preface message with tier-aware content blocks.
      //
      // Pre-Phase-B layout (kept here for reference during dogfood window):
      //   system: [getPreloadedContext, ...environmentPrompts,
      //            ...(parent ? [] : instructionPrompts),
      //            gatedLazyCatalogPrompt?, STRUCTURED_OUTPUT?, ...noticeAddenda]
      const preloadParts = await getPreloadParts(sessionID)
      const envParts = await SystemPrompt.environmentParts(activeModel, sessionID, session.parentID)
      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        accountId: effectiveAccountId,
        // T1 preload (DD-1): cwd + README. Empty string for missing pieces is fine.
        preload: preloadParts,
        // DD-2: today's date last in T1, sourced from environmentParts split.
        todaysDate: envParts.todaysDate,
        // DD-12 L3c: AGENTS.md text. Subagents skip via LLM.stream gate, but
        // we also short-circuit here for clarity and to avoid the disk read.
        agentsMd: session.parentID
          ? ""
          : [envParts.baseEnv + "\n</env>\n<directories>\n  \n</directories>", ...instructionPrompts]
              .filter(Boolean)
              .join("\n"),
        // Trailing per-turn extras: lazy catalog + structured-output directive
        // + subagent return notices. Carried into preface trailing tier in
        // LLM.stream (cache-friendly: rides the user-turn invalidation).
        system: [
          // DD-19: context budget rides the trailing (uncached) tier, not a cached
          // conversation message — see the contextBudgetText note above.
          ...(contextBudgetText ? [contextBudgetText] : []),
          ...(gatedLazyCatalogPrompt ? [gatedLazyCatalogPrompt] : []),
          ...(format.type === "json_schema" ? [STRUCTURED_OUTPUT_SYSTEM_PROMPT] : []),
          ...noticeAddenda,
          // Max-steps directive is instruction-style ("tools disabled, respond
          // text only, overrides all instructions"), so it belongs in the
          // system tier — NOT as a trailing {role:assistant} message. Anthropic
          // models reject a conversation ending with an assistant message
          // ("does not support assistant message prefill"); injecting it here is
          // provider-agnostic and avoids that 400.
          // issues/bug_20260529_claude_assistant_prefill_400.md
          ...(isLastStep ? [MAX_STEPS] : []),
        ],
        messages: SessionCompaction.sanitizeOrphanedToolCalls([
          // Context Sharing v2: prepend parent messages as stable prefix for child sessions.
          // This gives the child full visibility into parent's context (plan, discoveries, etc.)
          // at near-zero cost due to automatic prompt caching on the stable prefix.
          ...(parentMessagePrefix
            ? [
                ...MessageV2.toModelMessages(parentMessagePrefix, activeModel),
                {
                  role: "user" as const,
                  content: [
                    {
                      type: "text" as const,
                      text: "--- You are now operating as a delegated subagent. Above is the parent session's full context. Your assigned task follows below. ---",
                    },
                  ],
                },
              ]
            : []),
          ...MessageV2.toModelMessages(sessionMessages, activeModel),
        ]),
        tools: gatedTools,
        lazyTools: gatedLazyTools,
        model: activeModel,
        contextBudget,
        toolChoice: gatedToolChoice,
        idleWatchdogBox,
      })

      if (structuredOutput !== undefined) {
        processor.message.structured = structuredOutput
        processor.message.finish = processor.message.finish ?? "stop"
        await Session.updateMessage(processor.message)
        break
      }

      if (
        result === "stop" &&
        format.type === "json_schema" &&
        !processor.message.error &&
        !["tool-calls", "unknown"].includes(processor.message.finish ?? "")
      ) {
        processor.message.error = new MessageV2.StructuredOutputError({
          message: "Model did not produce structured output",
          retries: 0,
        }).toObject()
        await Session.updateMessage(processor.message)
        break
      }
      if (result === "stop") {
        // processor returned "stop" → blocked (permission/question rejected)
        // or assistant error. Workflow state is already set inside processor.
        // Child sessions must also stop here — parent/task completion wiring
        // owns any follow-up, and child self-nudging can create synthetic loops.
        //
        // Rate-limit exhaustion recovery: when all accounts are rate-limited
        // but autonomous todos remain, enqueue a delayed continuation so the
        // supervisor resumes after the rate limit clears. Without this, the
        // session goes idle permanently even though work remains.
        if (processor.message.finish === "rate_limited" && !session.parentID) {
          const decision = await decideAutonomousContinuation({ sessionID, lastDecisionReason })
          if (decision.continue) {
            await handleContinuationSideEffects({
              sessionID,
              user: lastUser,
              decision,
              autonomousRounds,
            })
            // Compute rate-limit backoff: use the shortest wait across all
            // accounts for this provider/model. Floor at 30s to avoid busy-loop.
            const { Account } = await import("@/account")
            const family = (await Account.resolveFamily(resolvedModel.providerId)) ?? resolvedModel.providerId
            const waitMs = await Account.getMinWaitTime(family, resolvedModel.modelID).catch(() => 0)
            const retryAt = Date.now() + Math.max(waitMs, 30_000)
            await Session.setWorkflowState({
              sessionID,
              state: "waiting_user",
              stopReason: "rate_limited_retry",
              lastRunAt: Date.now(),
            }).catch(() => undefined)
            await Session.updateWorkflowSupervisor({
              sessionID,
              patch: { retryAt },
              clear: ["leaseOwner", "leaseExpiresAt"],
            }).catch(() => undefined)
            log.info("loop:rate_limited_enqueued_continuation", {
              sessionID,
              step,
              autonomousRounds,
              retryAt,
              waitMs,
            })
            break
          }
        }
        break
      }
      if (result === "compact") {
        consecutiveCompactions++
        if (consecutiveCompactions >= 3) {
          log.warn("breaking compaction loop — model may be unable to reduce context", {
            sessionID,
            step,
            consecutiveCompactions,
            model: resolvedModel,
          })
          break
        }
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: resolvedModel,
          format: lastUser.format,
          auto: true,
        })
      } else {
        consecutiveCompactions = 0
      }
      // Terminal finish boundary: decide whether the session continues.
      //   • Subagent: always break (child is done). The parent-side watchdog
      //     in task.ts owns hang recovery — no retry needed here.
      //   • Root session: evaluate autonomous continuation. If there's a
      //     pending todo, enqueue a synthetic continuation and loop again.
      //     Otherwise persist the stop reason and break.
      if (processor.message.finish && !["tool-calls", "unknown", "other"].includes(processor.message.finish)) {
        if (session.parentID) {
          log.info("loop: subagent terminal finish", {
            sessionID,
            step,
            finish: processor.message.finish,
            result,
          })
          break
        }
        const decision = await decideAutonomousContinuation({
          sessionID,
          lastDecisionReason,
        })
        lastDecisionReason = decision.reason
        if (decision.continue) {
          const continuationResult = await handleContinuationSideEffects({
            sessionID,
            user: lastUser,
            decision,
            autonomousRounds,
          })
          autonomousRounds = continuationResult.nextRoundCount
          continue
        }
        // Stop. Persist workflow state by reason.
        const stopState = resolveTerminalContinuationStopState(decision)
        await Session.setWorkflowState({
          sessionID,
          state: stopState.state,
          stopReason: stopState.stopReason,
          lastRunAt: Date.now(),
        })
        debugCheckpoint("prompt", "loop:continuation_stopped", {
          sessionID,
          step,
          reason: decision.reason,
          autonomousRounds,
        })
        log.info("loop:continuation_stopped", { sessionID, reason: decision.reason })
        break
      }
      continue
    }

    // ── Idle compaction trigger at turn boundary ──
    // T6 (compaction_simplification): SharedContext.updateFromTurn is
    // retired. The workspace state is now derived in batch at compaction
    // time (see SharedContext.extractWorkspaceBatch + memory.ts). Only
    // the task-dispatch-triggered idleCompaction stays here.
    if (!session.parentID) {
      try {
        const config = await Config.get()
        const { messages: finalMsgs } = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
        const lastAssistantMsg = finalMsgs.findLast((m) => m.info.role === "assistant")
        if (lastAssistantMsg) {
          const hasTaskDispatch = lastAssistantMsg.parts.some(
            (p) => p.type === "tool" && p.tool === "task" && p.state.status !== "pending",
          )
          if (hasTaskDispatch) {
            const lastFinishedInfo = lastAssistantMsg.info as MessageV2.Assistant
            if (lastFinishedInfo.tokens) {
              const model = await Provider.getModel(lastFinishedInfo.providerId, lastFinishedInfo.modelID)
              await SessionCompaction.idleCompaction({
                sessionID,
                model,
                config,
              })
            }
          }
        }
      } catch (err) {
        log.warn("idle compaction trigger failed (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    log.info("loop:exit_returning", { sessionID })
    // Phase 13 follow-up: tool-output prune retired (cache-hostile, only
    // delayed compaction). The 90%-overflow gate inside the loop body
    // handles all context management; loop exit is now pure return.
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      const queued = consumeCallbacks(sessionID)
      log.info("loop:found_assistant_message_returning", {
        sessionID,
        returnedMessageID: item.info.id,
        queuedCallbacks: queued.length,
      })
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    throw new Error("Impossible")
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => runLoop(sessionID))

  async function createUserMessage(
    input: PromptInput,
    session: Session.Info,
  ): Promise<{ info: MessageV2.User; parts: MessageV2.WithParts["parts"] }> {
    const { agent, partsInput, info } = await prepareUserMessageContext({
      sessionID: input.sessionID,
      messageID: input.messageID,
      agent: input.agent,
      model: input.model,
      format: input.format,
      variant: input.variant,
      noReply: input.noReply,
      tools: input.tools,
      system: input.system,
      parts: input.parts,
    })

    const safePartsInput = partsInput as PromptInput["parts"]
    const parts = await buildUserMessageParts({
      partsInput: safePartsInput,
      info: info as MessageV2.User,
      sessionID: input.sessionID,
      agentName: agent.name,
      agentPermission: agent.permission,
    })

    await persistUserMessage({
      info,
      parts,
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      messageID: input.messageID,
      variant: input.variant,
    })

    // attachment-lifecycle v5 (DD-22): upload no longer auto-queues images
    // into activeImageRefs. The preface inventory text (built by
    // buildAttachedImagesInventory in context-preface assembly) advertises
    // every uploaded image; AI explicitly calls reread_attachment to bring
    // specific filenames into the next turn's preface trailing tier.
    //
    // The v4 addOnUpload helper is intentionally retained (unused here) so
    // future re-enablement is a one-line revert.

    return {
      info,
      parts,
    }
  }

  export const ShellInput = z.object({
    sessionID: Identifier.schema("session"),
    agent: z.string(),
    model: z
      .object({
        providerId: z.string(),
        modelID: z.string(),
        accountId: z.string().optional(),
      })
      .optional(),
    variant: z.string().optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const runtime = start(input.sessionID)
    if (!runtime) {
      throw new Session.BusyError(input.sessionID)
    }
    using _ = defer(() => finishRuntime(input.sessionID, runtime.runID))

    return runShellPrompt(input, runtime.signal)
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z
      .union([
        z.string(),
        z.object({
          providerId: z.string(),
          modelID: z.string(),
          accountId: z.string().optional(),
        }),
      ])
      .optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  export async function command(input: CommandInput) {
    log.info("command", input)

    const commandInfo = await Command.get(input.command)
    if (!commandInfo) {
      throw new Error(`Command not found: ${input.command}`)
    }

    if (commandInfo.handler) {
      return executeHandledCommand({
        commandInfo: commandInfo as Command.Info & { handler: () => Promise<{ output: string; title?: string }> },
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      })
    }

    const templateCommand = await commandInfo.template
    const template = await renderCommandTemplate({
      templateCommand,
      argumentsText: input.arguments,
    })
    const { parts, userAgent, userModel } = await prepareCommandPrompt({
      commandInfo: commandInfo,
      commandName: input.command,
      sessionID: input.sessionID,
      inputAgent: input.agent,
      inputModel: input.model,
      inputParts: input.parts,
      template,
      resolvePromptParts,
    })

    return dispatchCommandPrompt({
      commandName: input.command,
      sessionID: input.sessionID,
      argumentsText: input.arguments,
      parts,
      invoke: () =>
        prompt({
          sessionID: input.sessionID,
          messageID: input.messageID,
          model: userModel,
          agent: userAgent,
          parts,
          variant: input.variant,
        }) as Promise<MessageV2.WithParts>,
    })
  }
}
