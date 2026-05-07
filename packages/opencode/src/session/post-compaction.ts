import { Log } from "../util/log"
import { Session } from "."
import { Todo } from "./todo"
import type { MessageV2 } from "./message-v2"
import { WorkingCache } from "./working-cache"
import { Token } from "@/util/token"

const log = Log.create({ service: "post-compaction" })

/**
 * Post-Compaction Quick Follow-Up Table
 *
 * RC 2026-05-01: compaction's `applyStreamAnchorRebind` truncates everything
 * before the anchor, so any runtime state that the AI knew via prior tool
 * calls / messages is gone. Disk-persisted state (todolist, in-flight
 * subagents, memory entries, etc.) survives in the runtime, but the AI has
 * no way to see it post-compaction without re-issuing tool calls — and its
 * instinct is often to *re-establish* what already exists, not query it.
 *
 * This module collects "follow-up notes" from a registry of providers and
 * surfaces them inside the compaction summary text + the synthetic
 * continueMsg user message. Each provider answers one question: "what runtime
 * state do I hold that the AI should remember post-compaction, and what is
 * the directive associated with it?"
 *
 * Adding a new follow-up = implement a Provider, register it. compaction.ts
 * stays untouched.
 */
export namespace PostCompaction {
  /** Result of a single provider's gather() call. */
  export interface FollowUp {
    /** Section heading inside the summary addendum (markdown ##). */
    title: string
    /**
     * Markdown body for the summary section. Empty/null = skip this provider
     * entirely (no heading, no continueHint).
     */
    summaryBody: string | null
    /**
     * Optional terse directive sentence(s) that get woven into the synthetic
     * continueMsg. Keep short — the continueMsg is a single user message and
     * accumulates across providers.
     */
    continueHint?: string
  }

  export interface Provider {
    /** Stable identifier for diagnostics. */
    name: string
    /**
     * Compute the follow-up. Throws are caught at the framework level and
     * downgraded to "skip" so one provider can't kill compaction.
     */
    gather(sessionID: string): Promise<FollowUp | null>
  }

  const providers: Provider[] = []

  /** Register a provider. Idempotent on name. */
  export function register(p: Provider) {
    const existing = providers.findIndex((q) => q.name === p.name)
    if (existing >= 0) providers[existing] = p
    else providers.push(p)
  }

  /** For tests / diagnostics. */
  export function listRegistered(): readonly string[] {
    return providers.map((p) => p.name)
  }

  /** Run every provider, collect non-skipped follow-ups. */
  export async function gather(sessionID: string): Promise<FollowUp[]> {
    const out: FollowUp[] = []
    for (const p of providers) {
      try {
        const r = await p.gather(sessionID)
        if (r && r.summaryBody) out.push(r)
      } catch (e) {
        log.warn("provider failed", { provider: p.name, err: (e as Error)?.message })
      }
    }
    return out
  }

  /**
   * Build the markdown block appended to the compaction summary text. Empty
   * follow-up list → empty string (compaction stays unchanged).
   */
  export function buildSummaryAddendum(items: FollowUp[]): string {
    if (items.length === 0) return ""
    const sections = items.map((it) => `## ${it.title}\n\n${it.summaryBody}`)
    return (
      "\n\n# Post-Compaction Quick Follow-Up\n\n" +
      "The runtime preserved this state across the compaction boundary. " +
      "Use it as live context — do NOT re-establish what is already captured here.\n\n" +
      sections.join("\n\n")
    )
  }

  /**
   * Build the directive text for the synthetic continueMsg. Joins all
   * provider continueHints with explicit framing. If no provider supplied a
   * hint, returns a generic "follow your existing plan" line so the message
   * still has substance.
   */
  export function buildContinueText(items: FollowUp[]): string {
    const hints = items.map((it) => it.continueHint).filter((h): h is string => !!h)
    if (hints.length === 0) {
      return (
        "Compaction completed. Continue from your existing plan and runtime state. " +
        "Do NOT re-establish work that the runtime already tracks; only call setup tools " +
        "(todowrite, skill-load, etc.) when you are introducing genuinely new structure. " +
        "If there is no further work, stop with a brief summary."
      )
    }
    return (
      "Compaction completed. The runtime preserved the following state — act on it directly:\n\n" +
      hints.map((h, i) => `${i + 1}. ${h}`).join("\n") +
      "\n\nDo NOT re-establish what is already captured above. Only invoke setup/establishing " +
      "tools when you are introducing genuinely new structure."
    )
  }

  // ───────────────────────────────────────────────────────────────────────
  // Built-in providers
  // ───────────────────────────────────────────────────────────────────────

  /** Todolist — addresses the original RC. */
  const TodolistProvider: Provider = {
    name: "todolist",
    async gather(sessionID) {
      const todos = await Todo.get(sessionID).catch(() => [] as Todo.Info[])
      if (todos.length === 0) return null
      const lines = todos.map((t) => {
        const mark =
          t.status === "completed"
            ? "[x]"
            : t.status === "in_progress"
              ? "[~]"
              : t.status === "cancelled"
                ? "[-]"
                : "[ ]"
        return `- ${mark} ${t.content}`
      })
      const next = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending")
      const summaryBody =
        lines.join("\n") +
        "\n\nThis list is the durable projection of your plan. Continue executing the next " +
        "actionable item directly — do NOT call `todowrite` to restate or re-establish it. " +
        "Only call `todowrite` when the plan structure actually changes (item completed, " +
        "new step entered, scope shifted)."
      const continueHint = next
        ? `Todolist: next actionable item is "${next.content}" (status: ${next.status}). ` +
          `Continue executing it; do NOT call \`todowrite\` to restate the list.`
        : "Todolist: all items are completed or cancelled. If no further work is implied by the request, stop with a brief summary."
      return {
        title: "Todolist (already established — DO NOT re-write)",
        summaryBody,
        continueHint,
      }
    },
  }

  /**
   * In-flight subagents — addresses the worker.current loss case. If the
   * parent compacts while a child is still running, parent post-compaction
   * doesn't see the prior task() tool call and might re-dispatch.
   *
   * "Active" = session has parentID matching the compacting session AND its
   * last assistant message has no `finish` field set. Mirrors the heuristic
   * used by `system-manager:list_subagents`.
   */
  const InFlightSubagentsProvider: Provider = {
    name: "in-flight-subagents",
    async gather(sessionID) {
      const active: { childSessionID: string; title?: string; ageMs: number }[] = []
      try {
        for await (const s of Session.list()) {
          if (s.parentID !== sessionID) continue
          const messages = await Session.messages({ sessionID: s.id }).catch(() => [])
          const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant")
          const finished = !!(lastAssistant?.info as MessageV2.Assistant | undefined)?.finish
          if (finished) continue
          active.push({
            childSessionID: s.id,
            title: s.title,
            ageMs: Date.now() - (s.time?.created ?? Date.now()),
          })
        }
      } catch (e) {
        log.warn("in-flight scan failed", { err: (e as Error)?.message })
        return null
      }
      if (active.length === 0) return null
      const fmt = (ms: number) => {
        const sec = Math.round(ms / 1000)
        if (sec < 60) return `${sec}s`
        const min = Math.round(sec / 60)
        return `${min}m`
      }
      const lines = active.map(
        (a) => `- ${a.childSessionID} title=${JSON.stringify(a.title ?? "")} dispatched=${fmt(a.ageMs)} ago`,
      )
      const summaryBody =
        lines.join("\n") +
        "\n\nThese subagents are still running. You will receive a `[subagent ... finished ...]` " +
        "addendum on a future turn when each completes. Do NOT re-dispatch the same work; do NOT " +
        "assume the work was lost. If you need a child's intermediate output before it finishes, " +
        "use `system-manager.read_subsession` — do not spawn a duplicate."
      const summary = active.length === 1 ? `1 subagent in flight` : `${active.length} subagents in flight`
      return {
        title: "In-flight subagents (still running — do NOT re-dispatch)",
        summaryBody,
        continueHint:
          `${summary}: ${active.map((a) => a.childSessionID).join(", ")}. ` +
          `Wait for their completion notices; do NOT re-dispatch the same work.`,
      }
    },
  }

  /**
   * Working Cache awareness manifest (Phase B per plan revision DD-5 / DD-6 /
   * DD-22). Replaces the previous full-table render. Emits counts + topic
   * labels + retrieval tool names only — no fact bodies, no hashes, no path
   * enumeration. Token budget ≤120; if rendered text exceeds budget, drop
   * the provider output entirely (fail-closed, per INV-13).
   */
  const WorkingCacheProvider: Provider = {
    name: "working-cache",
    async gather(sessionID) {
      let messages: MessageV2.WithParts[] = []
      try {
        messages = await Session.messages({ sessionID }).catch(() => [])
      } catch (err) {
        log.warn("working-cache provider: messages fetch failed", { err: (err as Error)?.message })
        return null
      }
      const ledger = WorkingCache.deriveLedger(messages)
      const valid = await WorkingCache.selectValid({ kind: "session", sessionID }, 16).catch(() => ({
        entries: [] as WorkingCache.Entry[],
        omitted: [] as { entryID: string; reason: WorkingCache.ErrorCode | "WORKING_CACHE_SCOPE_UNRESOLVED" }[],
      }))
      if (ledger.length === 0 && valid.entries.length === 0 && valid.omitted.length === 0) return null

      const manifest = WorkingCache.buildManifest(ledger, valid.entries)
      const rendered = WorkingCache.renderManifest(manifest)
      if (Token.estimate(rendered) > 120) {
        log.warn("working-cache manifest over budget", { tokens: Token.estimate(rendered) })
        return null
      }

      const omittedSuffix =
        valid.omitted.length > 0 ? `\n\n(${valid.omitted.length} stale L1 entries omitted from counts above.)` : ""

      return {
        title: "Working Cache (awareness manifest)",
        summaryBody: rendered + omittedSuffix,
        continueHint:
          `Working Cache: ${manifest.l2.total} L2 ledger entries and ${manifest.l1.total} L1 digests available. ` +
          "Drill in via `system-manager:recall_toolcall_index` (refresh awareness), " +
          "`system-manager:recall_toolcall_raw` (specific toolcall, optional include_body), " +
          "or `system-manager:recall_toolcall_digest` (specific fact). Modifying actions still require fresh evidence verification.",
      }
    },
  }

  // Eager registration. Keep alphabetic for stable diagnostics output.
  register(InFlightSubagentsProvider)
  register(TodolistProvider)
  register(WorkingCacheProvider)
}
