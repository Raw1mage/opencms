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
  type CancelReason,
} from "./prompt-runtime"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { runShellPrompt } from "./shell-runner"
import { getPreloadedContext } from "./preloaded-context"
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
import { CapabilityLayer } from "./capability-layer"
import { registerProductionCapabilityLoader } from "./capability-layer-loader"

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

/**
 * compaction-redesign phase 6 — state-driven runloop evaluator (DD-1).
 *
 * Each runloop iteration calls this to decide whether SessionCompaction.run
 * should fire and what `observed` value to pass. Reads only **observable
 * session state** — no flags, no signals, no remembered intent from prior
 * iterations. State staleness is impossible because each call recomputes
 * from current Memory + session.execution + message-stream tail.
 *
 * Priority order (mirrors design.md pseudocode):
 *   1. Cooldown — if blocked, return null (no compaction this round)
 *   2. Manual — unprocessed compaction-request part in tail
 *   3. Provider switch — pinned providerId differs from last anchor's
 *   4. Rebind — pinned accountId differs from last anchor's (same provider)
 *   5. Overflow — lastFinished tokens exceed model budget
 *   6. Cache-aware — lastFinished tokens cross cache-prefix threshold
 *   7. Idle — turn boundary with capacity to compact opportunistically (deferred)
 *   null otherwise
 *
 * The "subagent / cron / parent" exclusion mirrors the pre-existing
 * legacy guards in the runloop: this function returns null when
 * `session.parentID` is set so subagent sessions don't self-compact.
 */
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
    if (await input.isCacheAware()) return "cache-aware"
  }

  return null
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

  const PLAN_ENFORCEMENT_ALLOWED_PROGRESS_PATTERNS = [
    /^(progress|status|current plan|current goal|resolved decisions|remaining open questions|next step)/i,
    /^(I (have|will|am)|We (have|will|are))/i,
  ]

  const PLAN_DECISION_QUESTION_PATTERNS = [
    /\?$/,
    /\b(should|which|what should|do you want|would you like|prefer|pick|choose|A or B|name|naming)\b/i,
    /還是|或者|要不要|是否|命名|選哪|哪個/i,
  ]

  const PLAN_DECISION_KEYWORDS = [
    "scope",
    "priority",
    "approval",
    "validation",
    "delegate",
    "delegation",
    "risk",
    "naming",
    "model",
    "provider",
    "account",
    "session-local",
    "global",
    "範圍",
    "優先",
    "批准",
    "驗證",
    "委派",
    "風險",
    "命名",
    "provider",
    "account",
    "model",
  ]

  export function classifyPlanModeAssistantTurn(input: {
    agentName: string
    finish?: string
    parts: MessageV2.WithParts["parts"]
  }) {
    if (input.agentName !== "plan")
      return { enforced: false as const, violation: false as const, reason: "not_plan" as const }

    const toolParts = input.parts.filter((part) => part.type === "tool")
    const hasQuestionTool = toolParts.some((part) => part.tool === "question")
    if (hasQuestionTool || input.finish === "tool-calls") {
      return {
        enforced: true as const,
        violation: false as const,
        reason: hasQuestionTool ? ("question_tool" as const) : ("tool_calls" as const),
      }
    }

    const textParts = input.parts.filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    const text = textParts
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
      .trim()
    if (!text) return { enforced: true as const, violation: false as const, reason: "empty_text" as const }

    const looksLikeProgress = PLAN_ENFORCEMENT_ALLOWED_PROGRESS_PATTERNS.some((pattern) => pattern.test(text))
    const looksLikeDecisionQuestion =
      PLAN_DECISION_QUESTION_PATTERNS.some((pattern) => pattern.test(text)) &&
      PLAN_DECISION_KEYWORDS.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase()))

    if (looksLikeDecisionQuestion) {
      return {
        enforced: true as const,
        violation: true as const,
        reason: "plain_text_decision_question" as const,
        text,
      }
    }

    if (text.includes("?") && !looksLikeProgress) {
      return {
        enforced: true as const,
        violation: true as const,
        reason: "plain_text_question" as const,
        text,
      }
    }

    return {
      enforced: true as const,
      violation: false as const,
      reason: looksLikeProgress ? ("progress_summary" as const) : ("non_question_text" as const),
    }
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

  export function buildSmartRunnerQuestion(input: { questionText?: string }) {
    const questionText = input.questionText?.trim()
    if (!questionText) return undefined
    return {
      question: questionText,
      header: "Decision needed",
      options: [],
      custom: true,
    } satisfies Question.Info
  }

  export function formatSmartRunnerQuestionAnswers(input: {
    question: Pick<Question.Info, "question">
    answers: Array<{ answer?: string[] }>
  }) {
    const answerText =
      input.answers
        .flatMap((item) => item.answer ?? [])
        .filter(Boolean)
        .join(", ") || "Unanswered"
    return `User answered Smart Runner question "${input.question.question}" with: ${answerText}. Continue with this answer in mind.`
  }

  function prefixAINarration(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return "[AI]"
    return trimmed.startsWith("[AI]") ? trimmed : `[AI] ${trimmed}`
  }

  async function persistSmartRunnerTrace(input: {
    sessionID: string
    trace: any
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
  }) {
    if (!input.persistTrace) return
    await input.persistTrace({
      sessionID: input.sessionID,
      trace: clone(input.trace),
    })
  }

  export async function handleSmartRunnerAskUserAdoption(input: {
    sessionID: string
    question: Question.Info
    trace: any
    lastUser: Pick<MessageV2.User, "agent" | "model" | "variant" | "format"> & { id?: string }
    ask?: (input: { sessionID: string; question: Question.Info }) => Promise<Question.Answer[]>
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
    updateMessage?: (message: any) => Promise<unknown>
    updatePart?: (part: any) => Promise<unknown>
    setWorkflowState?: typeof Session.setWorkflowState
  }) {
    const ask =
      input.ask ??
      (async ({ sessionID, question }: { sessionID: string; question: Question.Info }) =>
        Question.ask({ sessionID, questions: [question] }))
    const updateMessage = input.updateMessage ?? Session.updateMessage
    const updatePart = input.updatePart ?? Session.updatePart
    const setWorkflowState = input.setWorkflowState ?? Session.setWorkflowState

    try {
      const answers = await ask({ sessionID: input.sessionID, question: input.question })
      await persistSmartRunnerTrace(input)

      const userMessage: MessageV2.User = {
        id: Identifier.ascending("message"),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.lastUser.agent,
        model: input.lastUser.model,
        variant: input.lastUser.variant,
        format: input.lastUser.format,
      }
      await updateMessage(userMessage)
      await updatePart({
        id: Identifier.ascending("part"),
        messageID: userMessage.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: formatSmartRunnerQuestionAnswers({
          question: input.question,
          answers: [{ answer: answers[0] }],
        }),
      })
      return { outcome: "answered" as const }
    } catch (error) {
      if (!(error instanceof Question.RejectedError)) throw error
      await persistSmartRunnerTrace(input)
      await persistSmartRunnerTrace(input)
      await setWorkflowState({
        sessionID: input.sessionID,
        state: "waiting_user",
        stopReason: "product_decision_needed",
      })
      return { outcome: "rejected" as const }
    }
  }

  export async function handleSmartRunnerApprovalRequest(input: {
    sessionID: string
    trace: any
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
    setWorkflowState?: typeof Session.setWorkflowState
  }) {
    await persistSmartRunnerTrace(input)
    await (input.setWorkflowState ?? Session.setWorkflowState)({
      sessionID: input.sessionID,
      state: "waiting_user",
      stopReason: "approval_needed",
    })
    return { outcome: "requested" as const }
  }

  export async function handleSmartRunnerRiskPause(input: {
    sessionID: string
    trace: any
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
    setWorkflowState?: typeof Session.setWorkflowState
  }) {
    await persistSmartRunnerTrace(input)
    await (input.setWorkflowState ?? Session.setWorkflowState)({
      sessionID: input.sessionID,
      state: "waiting_user",
      stopReason: "risk_review_needed",
    })
    return { outcome: "paused" as const }
  }

  export async function handleSmartRunnerCompletionAdoption(input: {
    sessionID: string
    todos: Todo.Info[]
    suggestion: any
    roundCount: number
    updateTodos: (input: any) => Promise<unknown>
    decideContinuation: (input: { sessionID: string; roundCount: number }) => Promise<any>
    setWorkflowState?: typeof Session.setWorkflowState
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
    trace: any
  }) {
    const adopted = Todo.applyHostAdoptedCompletion(input.todos, input.suggestion.completionRequest)
    const trace = clone(input.trace)
    if (trace?.suggestion?.completionRequest) {
      trace.suggestion.completionRequest.hostAdopted = adopted.adopted
      trace.suggestion.completionRequest.hostAdoptionReason = adopted.reason
    }
    await persistSmartRunnerTrace({ sessionID: input.sessionID, trace, persistTrace: input.persistTrace })
    if (!adopted.adopted) return adopted

    await input.updateTodos({ sessionID: input.sessionID, todos: adopted.todos, mode: "status_update" })
    const decision = await input.decideContinuation({ sessionID: input.sessionID, roundCount: input.roundCount })
    if (decision.continue) {
      return {
        adopted: false as const,
        reason: "not_terminal_after_completion" as const,
        decision,
        todos: adopted.todos,
      }
    }
    await (input.setWorkflowState ?? Session.setWorkflowState)({
      sessionID: input.sessionID,
      state: "completed",
      stopReason: decision.reason,
    })
    return {
      adopted: true as const,
      reason: "adopted" as const,
      outcome: "completed" as const,
      decision,
      todos: adopted.todos,
    }
  }

  export async function handleSmartRunnerReplanAdoption(input: {
    sessionID: string
    todos: Todo.Info[]
    suggestion: any
    roundCount: number
    fallbackDecision: any
    updateTodos: (input: any) => Promise<unknown>
    decideContinuation: (input: { sessionID: string; roundCount: number }) => Promise<any>
  }) {
    const adopted = Todo.applyHostAdoptedReplan(input.todos, input.suggestion.replanAdoption)
    if (!adopted.adopted) return { ...adopted, decision: input.fallbackDecision }
    await input.updateTodos({ sessionID: input.sessionID, todos: adopted.todos, mode: "status_update" })
    const decision = await input.decideContinuation({ sessionID: input.sessionID, roundCount: input.roundCount })
    return {
      adopted: true as const,
      reason: "adopted" as const,
      decision,
      todos: adopted.todos,
    }
  }

  export async function handleSmartRunnerContinuationSideEffects(
    input: Parameters<typeof handleContinuationSideEffects>[0],
  ) {
    // Runner silent: no narration emitted
    // The autonomous runner operates silently in the background
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
      narration: undefined, // Runner no longer emits narration
    }
  }

  export async function handleSmartRunnerAdoptedStopNarration(input: {
    sessionID: string
    user: Pick<MessageV2.User, "id" | "agent" | "variant" | "model">
    text: string
    kind?: "pause" | "complete"
    emitNarration?: typeof emitAutonomousNarration
  }) {
    await (input.emitNarration ?? emitAutonomousNarration)({
      sessionID: input.sessionID,
      parentID: input.user.id,
      agent: input.user.agent,
      variant: input.user.variant,
      model: input.user.model,
      kind: input.kind ?? "pause",
      text: prefixAINarration(input.text),
    })
    return { emitted: true as const }
  }

  export async function handleSmartRunnerStopDecision(input: {
    sessionID: string
    activeModel: any
    autonomousRounds: number
    lastUser: MessageV2.User
    messages: MessageV2.WithParts[]
    todos: Todo.Info[]
    decision: any
    getConfig: () => Promise<{ enabled?: boolean; assist?: boolean }>
    evaluateGovernor: (input: any) => Promise<any>
    listQuestions: () => Promise<any[]>
    askUser?: (input: any) => Promise<any>
    requestApproval?: (input: any) => Promise<any>
    pauseForRisk?: (input: any) => Promise<any>
    completePath?: (input: any) => Promise<any>
    replan?: (input: any) => Promise<any>
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
    applyAssist?: (input: any) => any
  }) {
    const config = await input.getConfig()
    if (!config.enabled) return { kind: "continue" as const, continueDecision: input.decision }

    const trace = await input.evaluateGovernor({
      sessionID: input.sessionID,
      activeModel: input.activeModel,
      autonomousRounds: input.autonomousRounds,
      lastUser: input.lastUser,
      messages: input.messages,
      todos: input.todos,
      decision: input.decision,
    })

    if (
      trace.suggestion?.approvalRequest?.policy?.adoptionMode &&
      trace.suggestion.approvalRequest.policy.adoptionMode !== "host_adoptable"
    ) {
      trace.suggestion.approvalRequest.hostAdoptionReason = "policy_not_host_adoptable"
      await persistSmartRunnerTrace({ sessionID: input.sessionID, trace, persistTrace: input.persistTrace })
      return { kind: "continue" as const, continueDecision: input.decision }
    }

    if (
      trace.suggestion?.riskPauseRequest?.policy?.adoptionMode &&
      trace.suggestion.riskPauseRequest.policy.adoptionMode !== "host_adoptable"
    ) {
      trace.suggestion.riskPauseRequest.hostAdoptionReason = "policy_not_host_adoptable"
      await persistSmartRunnerTrace({ sessionID: input.sessionID, trace, persistTrace: input.persistTrace })
      return { kind: "continue" as const, continueDecision: input.decision }
    }

    const governorDecision = trace.decision?.decision
    if (governorDecision === "ask_user") {
      const question = buildSmartRunnerQuestion({
        questionText: trace.decision?.nextAction?.narration ?? trace.decision?.reason,
      })
      const outcome = await input.askUser?.({
        sessionID: input.sessionID,
        question,
        trace,
        lastUser: input.lastUser,
      })
      return { kind: "ask_user" as const, adopted: true as const, ...outcome }
    }

    if (governorDecision === "request_approval") {
      const outcome = await input.requestApproval?.({ sessionID: input.sessionID, trace })
      return { kind: "request_approval" as const, adopted: true as const, ...outcome }
    }

    if (governorDecision === "pause_for_risk") {
      const outcome = await input.pauseForRisk?.({ sessionID: input.sessionID, trace })
      return { kind: "pause_for_risk" as const, adopted: true as const, ...outcome }
    }

    if (governorDecision === "complete") {
      const outcome = await input.completePath?.({ sessionID: input.sessionID, trace })
      return { kind: "complete" as const, adopted: true as const, ...outcome }
    }

    let continueDecision = input.decision
    if (input.replan) {
      const replanned = await input.replan({
        sessionID: input.sessionID,
        todos: input.todos,
        roundCount: input.autonomousRounds,
        trace,
      })
      continueDecision = replanned?.decision ?? continueDecision
    }

    if (input.applyAssist && config.assist) {
      const assisted = input.applyAssist({
        trace,
        decision: continueDecision,
        todos: input.todos,
      })
      await persistSmartRunnerTrace({ sessionID: input.sessionID, trace, persistTrace: input.persistTrace })
      if (assisted?.applied && assisted.decision) {
        return {
          kind: "continue" as const,
          narrationOverride: assisted.narration ? prefixAINarration(assisted.narration) : undefined,
          continueDecision: {
            ...assisted.decision,
            text: prefixAINarration(assisted.decision.text),
          },
        }
      }
    }

    if (input.persistTrace) {
      await persistSmartRunnerTrace({ sessionID: input.sessionID, trace, persistTrace: input.persistTrace })
    }
    return { kind: "continue" as const, continueDecision }
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
          if (anchorIdx !== -1) {
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
            auto: true,
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

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
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
        log.warn("breaking empty-response loop", { sessionID, emptyRounds: emptyRoundCount, step })
        lastAssistant.error = new NamedError.Unknown({
          message:
            "Model returned an empty response. This may indicate a provider, account, or session context issue. Try sending a different message or starting a new session.",
        }).toObject()
        lastAssistant.finish = "error"
        await Session.updateMessage(lastAssistant)
        break
      }

      // Hotfix 2026-04-29: tool-call planning loop detector. When the model
      // calls the same tool with near-identical input across 2 consecutive
      // assistant turns, treat it as paralysis (the tool-result didn't help
      // it advance) and surface an error instead of letting runloop continue
      // forever. Symptom that motivated this: 116-round todowrite loop on a
      // session-storage smoke-test prompt where each round rewrote the same
      // todo list with cosmetic edits.
      //
      // Signature: array of `<toolName>:<first-200-chars-of-input>` per tool
      // call. Two consecutive completed assistant turns with identical
      // signatures → hard stop. Single-tool-once-each is fine; even one
      // repeat trips the brake. (Tightened from 3 → 2 per user request:
      // 3 felt too lenient when each loop costs an LLM call.)
      if (lastAssistant?.finish === "tool-calls" && lastAssistant.id > lastUser.id) {
        const recentAssistants: MessageV2.WithParts[] = []
        for (let i = msgs.length - 1; i >= 0 && recentAssistants.length < 2; i--) {
          if (msgs[i].info.role === "assistant") {
            const a = msgs[i].info as MessageV2.Assistant
            if (a.finish === "tool-calls" && (a.tokens.input > 0 || a.tokens.output > 0)) {
              recentAssistants.push(msgs[i])
            }
          }
        }
        if (recentAssistants.length === 2) {
          const sigs = recentAssistants.map((m) => {
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
            log.warn("breaking tool-call planning loop", {
              sessionID,
              step,
              signature: sigs[0].slice(0, 200),
              consecutiveRepeats: 2,
            })
            lastAssistant.error = new NamedError.Unknown({
              message:
                "Model is repeating the same tool call (2 consecutive identical turns). Stopping to prevent runaway. The model may be paralyzed planning instead of acting — try rephrasing your request, or send a corrective instruction.",
            }).toObject()
            lastAssistant.finish = "error"
            await Session.updateMessage(lastAssistant)
            break
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
          if (result.applied) {
            msgs = result.messages
            // Refresh lastFinished.tokens.input so the state-driven
            // evaluator below sees the RECONSTRUCTED prompt size, not the
            // pre-rebind assistant message's stale `tokens.input`.
            if (lastFinished) {
              const reconstructedTokens = estimateMsgsTokenCount(msgs)
              lastFinished = {
                ...lastFinished,
                tokens: { ...lastFinished.tokens, input: reconstructedTokens },
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
            log.warn("rebind skipped: unsafe boundary at first post-anchor message", {
              sessionID,
              anchorIndex: result.anchorIndex,
            })
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
        Bus.publish(TuiEvent.ToastShow, {
          title: "Model Rotated",
          message: `Using ${change} for image input`,
          variant: "info",
          duration: 4000,
        }).catch(() => {})

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
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
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
        await CapabilityLayer.get(sessionID, RebindEpoch.current(sessionID))
      } catch (err) {
        // Loud warn — AGENTS.md 第一條 prohibits silent fallback.
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

      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        accountId: effectiveAccountId,
        system: [
          await getPreloadedContext(sessionID),
          ...environmentPrompts,
          // Only include heavy instruction prompts (AGENTS.md) for Main Agents (no parentID).
          // Subagents should rely on the task description and SYSTEM.md.
          ...(session.parentID ? [] : instructionPrompts),
          ...(lazyCatalogPrompt ? [lazyCatalogPrompt] : []),
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
          ...MessageV2.toModelMessages(sessionMessages, activeModel),
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ]),
        tools,
        lazyTools,
        model: activeModel,
        toolChoice: format.type === "json_schema" ? "required" : undefined,
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
        const planTurnCheck = classifyPlanModeAssistantTurn({
          agentName: agent.name,
          finish: processor.message.finish,
          parts: await MessageV2.parts(processor.message.id),
        })
        if (planTurnCheck.enforced && planTurnCheck.violation) {
          processor.message.error = new NamedError.Unknown({
            message:
              `Plan mode enforcement violation: ${planTurnCheck.reason}. ` +
              `Bounded or execution-shaping questions must use MCP question; allowed endings are question tool or non-question progress summary.`,
          }).toObject()
          await Session.updateMessage(processor.message)
          break
        }

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
