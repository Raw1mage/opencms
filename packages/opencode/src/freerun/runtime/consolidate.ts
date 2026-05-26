/**
 * harness/freerun-mode — subtree consolidation (DD-3c).
 *
 * When a subtree settles (all nodes done|blocked|decomposed-with-no-actionable-
 * descendants), consolidation collapses the detail into a single summary on the
 * subtree root and archives the children. This mirrors human memory
 * consolidation — completed detail compressed to a paragraph the model can read
 * in O(1) instead of O(subtree size).
 *
 * Trigger: called by the engine loop after each iteration. Walks up from the
 * just-touched node looking for the deepest ancestor whose subtree is now
 * complete (per consolidation_threshold). Recurses upward only after each
 * ancestor's children have been archived (so the next ancestor sees the
 * post-archive shape).
 *
 * Like iterate.ts, the LLM call is via an injected client; consolidate.ts
 * owns NO HTTP.
 */

import { Tree } from "../storage/tree"
import { NodeFS } from "../storage/node-fs"
import type { ContextNode, ExperimentConfig } from "../types"

export namespace Consolidate {
  // ============================================================================
  // LLM seam
  // ============================================================================

  export interface SummarizeRequest {
    /** The subtree root node (about to receive the consolidated summary). */
    parent: ContextNode
    /** Children nodes in DFS preorder, about to be archived. */
    children: ContextNode[]
    /** Soft cap. */
    maxTokens: number
  }

  export interface SummarizeClient {
    summarize(req: SummarizeRequest): Promise<string>
  }

  // ============================================================================
  // Public API
  // ============================================================================

  export interface ConsolidateOptions {
    sessionId: string
    dataHome: string
    config: ExperimentConfig
    llm: SummarizeClient
    /** Node id just modified — consolidation walks UP from here. */
    seedNodeId: string
    /** ISO timestamp source — injectable for tests. */
    nowIso?: () => string
  }

  export interface ConsolidateResult {
    /** Number of ancestors that were consolidated this pass (0 = nothing to do). */
    consolidatedCount: number
    /** Archive stamp used (only set when consolidatedCount > 0). */
    archiveStamp?: string
  }

  /**
   * Walk up from `seedNodeId`. For each ancestor (including the seed itself
   * if it's `decomposed`), check whether its subtree is complete; if so,
   * summarize + archive + mark `done`. Stop walking when a non-complete
   * ancestor is found.
   */
  export async function consolidate(opts: ConsolidateOptions): Promise<ConsolidateResult> {
    const now = opts.nowIso ?? defaultNowIso
    const archiveStamp = makeArchiveStamp(now())
    let consolidatedCount = 0

    // Re-load tree before each candidate so prior archives reflect immediately.
    let candidateId: string | null = opts.seedNodeId
    while (candidateId !== null) {
      const tree = await Tree.load(opts.sessionId, opts.dataHome)
      const candidate = tree.byId.get(candidateId)
      if (candidate === undefined) break

      // Only `decomposed` nodes are consolidation candidates — they're the only
      // nodes that have children to roll up.
      if (candidate.mode !== "decomposed") {
        // Walk to parent for next round; the seed itself might be a leaf that
        // just transitioned to done — its parent may now be complete.
        candidateId = candidate.parent_id
        continue
      }

      if (!Tree.isSubtreeComplete(tree, candidate.id)) break

      // Subtree complete → summarize + archive.
      const descendants = collectChildrenForSummary(tree, candidate.id)
      let summary: string
      try {
        summary = await opts.llm.summarize({
          parent: candidate,
          children: descendants,
          maxTokens: opts.config.summary_token_cap_consolidation,
        })
      } catch (err) {
        // Consolidation failure is non-fatal — leave the subtree untouched.
        // Engine can retry on a later iteration; meanwhile pickNext will treat
        // the decomposed node as non-actionable so we won't spin.
        return { consolidatedCount, archiveStamp: consolidatedCount > 0 ? archiveStamp : undefined }
      }

      await Tree.archiveSubtree(tree, candidate.id, archiveStamp, opts.dataHome)
      const consolidated: ContextNode = {
        ...candidate,
        children_ids: [],
        mode: "done",
        consolidated_summary: summary,
        updated_at: now(),
      }
      await NodeFS.write(opts.sessionId, consolidated, opts.dataHome)
      consolidatedCount++

      // Recurse upward.
      candidateId = candidate.parent_id
    }

    return {
      consolidatedCount,
      archiveStamp: consolidatedCount > 0 ? archiveStamp : undefined,
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /** DFS preorder over children of the subtree root (the root itself excluded). */
  function collectChildrenForSummary(tree: Tree.Snapshot, rootId: string): ContextNode[] {
    const out: ContextNode[] = []
    for (const n of Tree.walkDFS(tree, rootId)) {
      if (n.id === rootId) continue
      out.push(n)
    }
    return out
  }

  function defaultNowIso(): string {
    return new Date().toISOString()
  }

  /** YYYY-MM-DDTHH-MM-SSZ — filesystem-safe ISO. */
  function makeArchiveStamp(iso: string): string {
    return iso.replace(/[:.]/g, "-").replace(/Z$/, "Z")
  }
}
