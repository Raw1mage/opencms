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
import { SessionCompaction } from "./compaction"
import { SharedContext } from "./shared-context"
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
 *   [subagent <childSessionID> finished status=<status> elapsed=<seconds>s<extras>]
 *
 * extras:
 *   rate_limited → errorDetail.resetsInSeconds
 *   quota_low    → rotateHint.exhaustedAccountId + remainingPercent
 *                  + explicit "rotate before next dispatch" instruction
 *   cancelled    → cancelReason (echo)
 */
function renderNoticeAddendum(n: MessageV2.PendingSubagentNotice): string {
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
  const hint =
    n.status === "quota_low"
      ? " Switch to a different account before any further dispatch; read the child session for the wrap-up summary."
      : n.status === "rate_limited"
        ? " The account is rate-limited; pick a different account or wait for reset before redispatching."
        : n.status === "worker_dead" || n.status === "silent_kill"
          ? " The subagent did not complete cleanly; read the child session for any partial progress before deciding recovery."
          : ""
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

function withContextBudgetEnvelope(input: {
  messages: MessageV2.WithParts[]
  lastFinished?: MessageV2.Assistant
  model: Provider.Model
}): MessageV2.WithParts[] {
  if (!input.lastFinished) return input.messages
  const budget = renderContextBudget({ lastFinished: input.lastFinished, model: input.model })
  if (!budget) return input.messages
  const lastUserIndex = input.messages.findLastIndex((msg) => msg.info.role === "user")
  if (lastUserIndex < 0) return input.messages
  const lastUser = input.messages[lastUserIndex]
  const budgetPart: MessageV2.TextPart = {
    id: `${lastUser.info.id}:context-budget`,
    messageID: lastUser.info.id,
    sessionID: lastUser.info.sessionID,
    type: "text",
    synthetic: true,
    text: budget,
    metadata: { contextBudget: true, excludeFromDisplay: true },
  }
  const next = input.messages.slice()
  next[lastUserIndex] = { ...lastUser, parts: [...lastUser.parts, budgetPart] }
  return next
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
] as const)

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
  // needs cutting. Fire-and-forget invalidateContinuationFamily (no-op for
  // non-codex providers) and return null so the runloop proceeds without
  // a destructive compaction round.
  if (lastAnchor) {
    if (lastAnchor.providerId && lastAnchor.providerId !== input.pinnedProviderId) {
      return "provider-switched"
    }
    if (lastAnchor.accountId && input.pinnedAccountId && lastAnchor.accountId !== input.pinnedAccountId) {
      void (async () => {
        try {
          const { invalidateContinuationFamily } = await import("@opencode-ai/codex-provider/continuation")
          invalidateContinuationFamily(input.sessionID)
        } catch {
          // best-effort; non-codex providers don't expose this module
        }
      })()
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

function hasUnreadAttachmentRefs(msgs: MessageV2.WithParts[]): boolean {
  const seen = new Set<string>()
  const read = new Set<string>()
  for (const msg of msgs) {
    for (const part of msg.parts) {
      if (part.type === "attachment_ref") {
        seen.add(part.ref_id)
        continue
      }
      if (part.type === "tool" && part.tool === "attachment" && part.state.status === "completed") {
        const refID = (part.state.input as { ref_id?: unknown })?.ref_id
        if (typeof refID === "string") read.add(refID)
      }
    }
  }
  for (const ref of seen) {
    if (!read.has(ref)) return true
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

    const shouldReplaceRuntime = await shouldInterruptForIncomingPrompt(input.sessionID)
    if (shouldReplaceRuntime) {
      await emitSessionNarration({
        sessionID: input.sessionID,
        parentID: message.info.id,
        agent: message.info.agent,
        variant: message.info.variant,
        model: message.info.model,
        text: "Interrupted the previous autonomous run and replanning around your latest message.",
        kind: "interrupt",
      })
    }
    return runLoop(input.sessionID, { replaceRuntime: shouldReplaceRuntime, incomingModel: input.model })
  })

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
            return { providerId: a.providerId, accountId: a.accountId }
          }
        }
        return undefined
      })()
      const prevProvider = lastAssistantIdentity?.providerId
      const nextProvider = options.incomingModel.providerId
      const prevAccount = lastAssistantIdentity?.accountId
      const nextAccount = options.incomingModel.accountId
      const providerChanged = !!prevProvider && prevProvider !== nextProvider
      const accountChanged =
        !providerChanged && !!prevProvider && prevAccount !== nextAccount && !!(prevAccount || nextAccount)
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
          // Phase 13.1: Memory.markCompacted call removed (Memory.lastCompactedAt
          // is derived from the most recent anchor's time.created, not stored).
          await SessionCompaction.compactWithSharedContext({
            sessionID,
            snapshot:
              snap ??
              `[Provider switched from ${prevProvider} to ${nextProvider}. Previous conversation context was not recoverable. The user may re-state their request.]`,
            model,
            auto: false,
          })
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
        await RebindEpoch.bumpEpoch({
          sessionID,
          trigger: "provider_switch",
          reason: `account ${prevAccount} → ${nextAccount}`,
        })
        try {
          const { invalidateContinuationFamily } = await import("@opencode-ai/codex-provider/continuation")
          invalidateContinuationFamily(sessionID)
          log.info("account switch: codex chain family reset (lastResponseId cleared)", { sessionID })
        } catch (err) {
          log.warn("account switch: codex chain reset failed (non-fatal)", {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          })
        }
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
      const filteredResult = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
      let msgs = filteredResult.messages
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
      const contextBudgetSource = findContextBudgetSource(msgs)
      const format = lastUser.format ?? { type: "text" }

      // Guard: detect empty-response loop (finish=unknown|other, 0 tokens).
      // "other" comes from codex SSE/WS that closed without a terminal event,
      // or response.incomplete with an unmapped reason. Same shape as
      // "unknown": empty body, 0 tokens, no parts.
      //
      // Hotfix 2026-04-29: fail fast instead of injecting a synthetic "?".
      // The nudge polluted the message stream and could add extra retries on
      // Codex context-overflow incidents, making double-reporting harder to
      // diagnose. A real recovery path must be explicit chain invalidation or
      // compaction, not hidden user-message fabrication.
      const isEmptyRound =
        (lastAssistant?.finish === "unknown" || lastAssistant?.finish === "other") &&
        lastAssistant.tokens.input === 0 &&
        lastAssistant.tokens.output === 0 &&
        lastAssistant.id > lastUser.id
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

        // Self-heal on transient empty response.
        //
        // 2026-05-01: empirical data shows the dominant cause of an
        // empty packet from codex is silent server-side context overflow
        // — the dialog hits ~80-85% of nominal context and codex starts
        // returning finishReason:unknown / totalTokens:0 instead of a
        // real reply. A text nudge cannot recover this; only shrinking
        // the context can. Trigger SessionCompaction with the dedicated
        // "empty-response" observed condition (chain prefers codex's own
        // /responses/compact via low-cost-server, falls through to local
        // narrative / replay-tail / llm-agent). After compaction the
        // anchor + Continue nudge takes us into the next iteration with
        // a small enough prompt that codex can actually respond.
        //
        // Subagents do not auto-compact (DD-12: parent owns context
        // management); they keep the legacy retry-nudge path so a real
        // transient blink still self-heals without disturbing parent.
        //
        // Storm-prevention gate (2026-05-05): the original hotfix targeted
        // codex silent overflow ("empirical data shows the dominant cause
        // of an empty packet from codex is silent server-side context
        // overflow — the dialog hits ~80-85% of nominal context"). Without
        // a usage gate, ANY transient SSE blip / network 5xx / model burp
        // at low context also fires destructive compaction, producing the
        // observed storm pattern (~83% of compactions in long sessions
        // traceable to empty rounds rather than real pressure). Only
        // compact when the last well-formed turn was already past the
        // configured floor (default 0.8 — matches the original 80-85%
        // window). Below that floor, fall through to the nudge path so a
        // genuine transient still self-heals without burning context.
        let overflowSuspected = false
        let probeRatio = 0
        const emptyResponseFloor = Tweaks.compactionSync().emptyResponseFloor
        if (contextBudgetSource) {
          const probeModel = await Provider.getModel(
            contextBudgetSource.providerId ?? lastUser.model.providerId,
            contextBudgetSource.modelID ?? lastUser.model.modelID,
          ).catch(() => undefined)
          const gate = evaluateEmptyResponseGate({
            used: contextBudgetSource.tokens?.input ?? 0,
            window: probeModel?.limit.input ?? probeModel?.limit.context ?? 0,
            floor: emptyResponseFloor,
          })
          overflowSuspected = gate.overflowSuspected
          probeRatio = gate.ratio
          log.info("self-heal: empty round usage probe", {
            sessionID,
            step,
            ratio: Number(probeRatio.toFixed(3)),
            floor: emptyResponseFloor,
            overflowSuspected,
          })
        }
        if (emptyRoundCount === 1 && !session.parentID && overflowSuspected) {
          log.info("self-heal: empty round 1 — triggering empty-response compaction", {
            sessionID,
            step,
          })
          // Hotfix 2026-05-05 — empty-response compaction was silently
          // dropping the user's most recent question. After compaction
          // commits its anchor (summary=1), `filterCompacted` truncates
          // context at the anchor; any message older than it (including
          // the unanswered user turn that just triggered the empty
          // response) becomes invisible to the next iteration's LLM
          // call. The model then saw only the compacted history + the
          // PostCompaction follow-up ("todos done, wrap up if no further
          // work implied") and produced a wrap-up reply, swallowing the
          // user's question entirely.
          //
          // Strategy: snapshot the unanswered user message + parts,
          // run compaction, then re-write the user message with a fresh
          // ULID. The new id is monotonically larger than the anchor's
          // id (time-ordered ULID), so filterCompacted picks it up.
          // Delete the originals after the replay is durable so the UI
          // doesn't render duplicates and the empty assistant doesn't
          // dangle.
          const replayUserFull = msgs.findLast((m) => m.info.id === lastUser.id)
          const replayUserInfo = replayUserFull ? ({ ...replayUserFull.info } as MessageV2.User) : undefined
          const replayUserParts = replayUserFull ? replayUserFull.parts.map((p) => ({ ...p }) as MessageV2.Part) : []
          const emptyAssistantID = lastAssistant.id
          try {
            const result = await SessionCompaction.run({
              sessionID,
              observed: "empty-response",
              step,
            })
            log.info("self-heal: empty-response compaction returned", { sessionID, step, result })
            if (replayUserInfo) {
              try {
                const newUserID = Identifier.ascending("message")
                const newUser: MessageV2.User = {
                  ...replayUserInfo,
                  id: newUserID,
                  time: { created: Date.now() },
                }
                await Session.updateMessage(newUser)
                for (const part of replayUserParts) {
                  await Session.updatePart({
                    ...part,
                    id: Identifier.ascending("part"),
                    messageID: newUserID,
                  } as MessageV2.Part)
                }
                await Session.removeMessage({ sessionID, messageID: emptyAssistantID })
                await Session.removeMessage({ sessionID, messageID: replayUserInfo.id })
                log.info("self-heal: replayed user message after anchor", {
                  sessionID,
                  step,
                  originalUserID: replayUserInfo.id,
                  newUserID,
                  emptyAssistantID,
                  partCount: replayUserParts.length,
                })
              } catch (replayErr) {
                log.error("self-heal: replay-after-compact failed; user message may be hidden behind anchor", {
                  sessionID,
                  step,
                  error: replayErr instanceof Error ? replayErr.message : String(replayErr),
                })
              }
            }
            // Whether it succeeded or fell through, the runloop should
            // re-evaluate with the new (potentially smaller) stream.
            continue
          } catch (err) {
            log.warn("self-heal: empty-response compaction threw, falling back to nudge", {
              sessionID,
              step,
              error: err instanceof Error ? err.message : String(err),
            })
            // fall through to the nudge path below
          }
        }
        if (emptyRoundCount === 1) {
          const nudgeModel = await Provider.getModel(lastUser.model.providerId, lastUser.model.modelID)
          const nudgeBudget = contextBudgetSource
            ? renderContextBudget({ lastFinished: contextBudgetSource, model: nudgeModel })
            : undefined
          log.info("self-heal: empty round 1, injecting retry nudge", {
            sessionID,
            step,
            isSubagent: !!session.parentID,
          })
          const nudgeUser: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: lastUser.agent,
            model: lastUser.model,
            variant: lastUser.variant,
          }
          await Session.updateMessage(nudgeUser)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: nudgeUser.id,
            sessionID,
            type: "text",
            text: ["?", nudgeBudget].filter((part): part is string => !!part).join("\n"),
            synthetic: true,
          } satisfies MessageV2.TextPart)
          continue
        }

        // emptyRoundCount >= 2: self-heal nudge already fired and the
        // next round is still empty. Two interpretations:
        //   (a) genuine codex overflow / chain corruption — runaway
        //   (b) model truly has nothing more to say (tools succeeded
        //       last round, this round is "natural stop" that codex
        //       didn't tag with a terminal event)
        //
        // (b) is the dominant case empirically (per 2026-04-30 obs).
        // Hard-erroring with a red toast on (b) is a bad UX: the
        // assistant claims failure when the work is actually complete.
        // Treat it as a clean stop — no error attached, finish=stop.
        // The warn log remains so a sustained (a) case is still
        // diagnosable from debug.log.
        log.warn("empty-response loop closed as natural stop", {
          sessionID,
          emptyRounds: emptyRoundCount,
          step,
          isSubagent: !!session.parentID,
        })
        lastAssistant.finish = "stop"
        await Session.updateMessage(lastAssistant)
        break
      }

      // Tool-call paralysis detectors — observability only (2026-05-03).
      // Decision: log signal, do not intervene. Removed nudge injection
      // (was: synthetic user message granting "ok to go") and hard-break
      // (was: lastAssistant.error + finish=error). The plan-mode police
      // that produced these loops were already removed, so we expect this
      // signal to be rare. Re-introduce intervention only if telemetry
      // shows a real runaway pattern.
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

        if (recentAssistants.length >= 2) {
          const sigs = recentAssistants.slice(0, 2).map((m) => {
            const tools = m.parts.filter((p) => p.type === "tool")
            return tools
              .map((p) => {
                const tp = p as MessageV2.ToolPart
                const input = (tp.state as { input?: unknown })?.input
                const inputStr = input ? JSON.stringify(input) : ""
                return `${tp.tool}:${inputStr.slice(0, 200)}`
              })
              .join("|")
          })
          if (sigs[0] && sigs[0] === sigs[1]) {
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
        }

        if (recentAssistants.length >= 2) {
          const leadingText = (m: MessageV2.WithParts): string => {
            const text = m.parts.find((p) => p.type === "text" && !(p as { synthetic?: boolean }).synthetic) as
              | { text?: string }
              | undefined
            return (text?.text ?? "").toLowerCase().replace(/\s+/g, "").slice(0, 600)
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
          const texts = recentAssistants.map(leadingText)
          const longEnough = texts.every((t) => t.length >= 60)
          if (longEnough) {
            const j01 = jaccard(bigrams(texts[0]), bigrams(texts[1]))
            if (j01 > 0.5) {
              log.warn("paralysis-observe: narrative repetition", {
                sessionID,
                step,
                similarity01: j01.toFixed(2),
                samplePrefix: texts[0].slice(0, 120),
              })
            }
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
          modelID: lastUser.model.modelID,
          providerId: lastUser.model.providerId,
          history: msgs,
        })

      // Respect session's pinned execution identity (set by rotation3d after rate-limit fallback).
      // Without this, each tool-loop iteration re-resolves to the original (rate-limited) model,
      // causing a retry storm as rotation fires on every iteration.
      const sessionExec = step > 1 ? (await Session.get(sessionID).catch(() => undefined))?.execution : undefined
      const effectiveProviderId = sessionExec?.providerId ?? lastUser.model.providerId
      const effectiveModelID = sessionExec?.modelID ?? lastUser.model.modelID
      const effectiveAccountId = sessionExec?.accountId ?? lastUser.model.accountId
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
      }
      const task = tasks.pop()
      // pending subtask (invocation routed via ToolInvoker)
      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const taskModel = task.model ? await Provider.getModel(task.model.providerId, task.model.modelID) : model
        const sessionExecution = (await Session.get(sessionID).catch(() => undefined))?.execution
        const taskAccountId =
          task.model?.providerId === (sessionExecution?.providerId ?? lastUser.model.providerId)
            ? (sessionExecution?.accountId ?? lastUser.model.accountId)
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
            model: lastUser.model,
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
        accountId: lastUser.model.accountId,
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
            accountId: lastUser.model.accountId,
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
            accountId: lastUser?.model.accountId,
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

      const resolvedToolsOutput = await resolveTools({
        agent,
        session,
        model: activeModel,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
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

      const sessionMessages = clone(msgs)
      if (imageResolution.dropImages) {
        stripImageParts(sessionMessages)
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

      const sessionMessagesForModel = withContextBudgetEnvelope({
        messages: sessionMessages,
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
          ...(gatedLazyCatalogPrompt ? [gatedLazyCatalogPrompt] : []),
          ...(format.type === "json_schema" ? [STRUCTURED_OUTPUT_SYSTEM_PROMPT] : []),
          ...noticeAddenda,
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
          ...MessageV2.toModelMessages(sessionMessagesForModel, activeModel),
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ]),
        tools: gatedTools,
        lazyTools: gatedLazyTools,
        model: activeModel,
        toolChoice: gatedToolChoice,
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
        break
      }
      if (result === "compact") {
        consecutiveCompactions++
        if (consecutiveCompactions >= 3) {
          log.warn("breaking compaction loop — model may be unable to reduce context", {
            sessionID,
            step,
            consecutiveCompactions,
            model: lastUser.model,
          })
          break
        }
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
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

    // ── Session Snapshot + Shared Context: incremental update + idle compaction at turn boundary ──
    {
      const config = await Config.get()
      if (config.compaction?.sharedContext !== false) {
        try {
          const { messages: finalMsgs } = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
          const lastAssistantMsg = finalMsgs.findLast((m) => m.info.role === "assistant")
          if (lastAssistantMsg) {
            const assistantText = lastAssistantMsg.parts
              .filter((p): p is MessageV2.TextPart => p.type === "text")
              .map((p) => p.text)
              .join("\n")

            await SharedContext.updateFromTurn({
              sessionID,
              parts: lastAssistantMsg.parts,
              assistantText,
              turnNumber: step,
            })

            // Phase 13.3-full: SharedContext.persistSnapshot removed. The
            // legacy `abstract_template/<sid>` Storage write was a frozen
            // copy of the regex-extracted snapshot — no consumers remain
            // (compaction-redesign reads from message-stream anchors and
            // Memory journal instead).

            if (!session.parentID) {
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
          }
        } catch (err) {
          log.warn("shared context update failed (non-fatal)", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
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
