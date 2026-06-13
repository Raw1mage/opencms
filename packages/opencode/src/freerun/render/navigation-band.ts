/**
 * harness/freerun-mode — always-present global navigation band (DD-3e).
 *
 * Synthesizes a header block injected into every iteration's prompt so the
 * model never loses sight of the root goal + where in the tree it is +
 * what its siblings are doing. Without this band the model would drift
 * after the first iteration because there's no message history to fall
 * back on.
 *
 * Layout (full policy):
 *
 *   # Goal (root)
 *   <root.title>
 *   <root.body, possibly trimmed>
 *
 *   # Path to current node
 *   - <root.title>
 *     - <…ancestor titles in order, root → parent…>
 *       - <current.title>
 *
 *   # Siblings of current node (mode + 1-line summary)
 *   - [<mode>] <sibling.title> — <sibling.consolidated_summary or trimmed body>
 *
 * Policies (nav_band_policy in ExperimentConfig):
 *   - "full"        — all four sections
 *   - "parent-only" — goal + path; no sibling block
 *   - "minimal"     — goal title + immediate parent title only
 *   - "off"         — empty string
 *
 * Token budget enforcement is char-based (≈ 4 chars/token). When exceeded,
 * the implementation trims by section in this order:
 *   1. sibling summaries (longest first)
 *   2. root body
 *   3. ancestor bodies (we never include those in v1 — titles only)
 * If still over budget after step 2, the band is truncated with an ellipsis
 * marker rather than dropping required structural lines.
 */

import { Tree } from "../storage/tree"
import type { ContextNode } from "../types"

export namespace NavigationBand {
  export type Policy = "full" | "parent-only" | "minimal" | "off"

  export interface RenderOptions {
    /** ExperimentConfig.nav_band_policy. */
    policy: Policy
    /** ExperimentConfig.nav_band_token_budget — approximate (≈ 4 chars/token). */
    tokenBudget: number
  }

  export interface RenderResult {
    /** The assembled nav band text (empty string if policy=off). */
    text: string
    /** Approximate token count of the returned text. */
    approxTokens: number
    /** True if any section was trimmed/dropped to fit budget. */
    trimmed: boolean
  }

  const CHARS_PER_TOKEN = 4

  /** Approximate token count for a chunk of text (cheap heuristic). */
  export function approxTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN)
  }

  /**
   * Render the nav band for `currentNodeId` in `tree`.
   * Pure function — no I/O.
   */
  export function render(tree: Tree.Snapshot, currentNodeId: string, opts: RenderOptions): RenderResult {
    if (opts.policy === "off") {
      return { text: "", approxTokens: 0, trimmed: false }
    }
    const root = Tree.get(tree, tree.rootId)
    const current = Tree.get(tree, currentNodeId)
    const charBudget = opts.tokenBudget * CHARS_PER_TOKEN

    if (opts.policy === "minimal") {
      const parent = current.parent_id === null ? null : tree.byId.get(current.parent_id) ?? null
      const parts = [
        "# Goal",
        root.title,
        "",
        parent === null ? "# Current node" : "# Parent → Current",
        parent === null ? current.title : `${parent.title} → ${current.title}`,
        "",
      ]
      const text = parts.join("\n")
      const result = truncateIfOver(text, charBudget)
      return { text: result.text, approxTokens: approxTokens(result.text), trimmed: result.trimmed }
    }

    // full / parent-only — start with goal + path, then add siblings only for "full".
    const sections: string[] = []

    // Section 1: Goal
    sections.push(formatGoalSection(root))

    // Section 2: Path
    sections.push(formatPathSection(tree, currentNodeId))

    // Section 3: Siblings (only if "full")
    let trimmedSiblings = false
    if (opts.policy === "full") {
      const sibs = Tree.siblings(tree, currentNodeId)
      if (sibs.length > 0) {
        const siblingSection = formatSiblingsSection(sibs)
        sections.push(siblingSection)
      }
    }

    let text = sections.join("\n\n") + "\n"
    let trimmed = false

    // Budget enforcement: progressively trim sibling summaries → root body → hard truncate.
    if (text.length > charBudget && opts.policy === "full") {
      const sibs = Tree.siblings(tree, currentNodeId)
      if (sibs.length > 0) {
        sections[sections.length - 1] = formatSiblingsSection(sibs, /* minimalSummary */ true)
        text = sections.join("\n\n") + "\n"
        trimmed = true
        trimmedSiblings = true
      }
    }
    if (text.length > charBudget) {
      // Trim root body section to title only.
      sections[0] = formatGoalSection(root, /* titleOnly */ true)
      text = sections.join("\n\n") + "\n"
      trimmed = true
    }
    if (text.length > charBudget) {
      // Hard truncate with marker (only ever as a last resort).
      const truncated = text.slice(0, charBudget - 5) + "…\n"
      text = truncated
      trimmed = true
    }
    void trimmedSiblings // currently informational only; exposed for future telemetry
    return { text, approxTokens: approxTokens(text), trimmed }
  }

  // ============================================================================
  // Section formatters
  // ============================================================================

  function formatGoalSection(root: ContextNode, titleOnly = false): string {
    const lines: string[] = ["# Goal (root)", root.title]
    if (root.goal_binding !== undefined) {
      lines.push(`source: ${root.goal_binding.source}`)
      if (root.goal_binding.source === "plan-task") {
        lines.push(`plan_task: ${root.goal_binding.plan_slug}#${root.goal_binding.task_id}`)
      }
    }
    if (!titleOnly && root.body.length > 0) {
      lines.push("", root.body)
    }
    return lines.join("\n")
  }

  function formatPathSection(tree: Tree.Snapshot, currentNodeId: string): string {
    // Collect chain root → … → current.
    const chain: ContextNode[] = []
    const ancestorList = Array.from(Tree.ancestors(tree, currentNodeId))
    ancestorList.reverse() // ancestors() yields parent-up; reverse → root-down
    chain.push(...ancestorList, Tree.get(tree, currentNodeId))

    const lines: string[] = ["# Path to current node"]
    chain.forEach((node, idx) => {
      const indent = "  ".repeat(idx)
      const marker = idx === chain.length - 1 ? "→" : "•"
      lines.push(`${indent}${marker} ${node.title}`)
    })
    return lines.join("\n")
  }

  function formatSiblingsSection(siblings: ContextNode[], minimalSummary = false): string {
    const lines: string[] = ["# Siblings"]
    for (const s of siblings) {
      const summary = pickSiblingSummary(s, minimalSummary)
      const summaryFragment = summary.length > 0 ? ` — ${summary}` : ""
      lines.push(`- [${s.mode}] ${s.title}${summaryFragment}`)
    }
    return lines.join("\n")
  }

  function pickSiblingSummary(node: ContextNode, minimal: boolean): string {
    // Prefer consolidated_summary when present (post-consolidation node).
    if (node.consolidated_summary !== null && node.consolidated_summary !== undefined && node.consolidated_summary.length > 0) {
      return clip(node.consolidated_summary, minimal ? 80 : 200)
    }
    // Fallback: next_intent (what this sibling planned to do next), else trimmed body.
    if (node.next_intent.length > 0) return clip(node.next_intent, minimal ? 60 : 140)
    if (node.body.length > 0) return clip(node.body.replace(/\n+/g, " "), minimal ? 60 : 140)
    return ""
  }

  function clip(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n - 1) + "…"
  }

  function truncateIfOver(text: string, charBudget: number): { text: string; trimmed: boolean } {
    if (text.length <= charBudget) return { text, trimmed: false }
    return { text: text.slice(0, charBudget - 5) + "…\n", trimmed: true }
  }
}
