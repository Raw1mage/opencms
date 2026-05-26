/**
 * harness/freerun-mode — tree-level operations over the per-node markdown store.
 *
 * The on-disk store (see node-fs.ts) is the source of truth. This module
 * loads the whole tree into an in-memory `Tree` snapshot and exposes
 * traversal / lookup helpers built on the snapshot. The engine reloads
 * the tree at the start of every iteration so writes between iterations
 * never need cache invalidation — pure read-after-write via the fs.
 *
 * Concurrency: single-agent serial (DD-20). No locking needed.
 */

import * as fs from "fs/promises"
import * as path from "path"
import { NodeFS } from "./node-fs"
import { sessionStorageDir, type ContextNode, type NodeMode } from "../types"

export namespace Tree {
  // ============================================================================
  // Snapshot type
  // ============================================================================

  export interface Snapshot {
    readonly sessionId: string
    /** Every loaded node, keyed by node.id. */
    readonly byId: ReadonlyMap<string, ContextNode>
    /** Root node id (the one with parent_id === null). */
    readonly rootId: string
  }

  // ============================================================================
  // Load / inspect
  // ============================================================================

  /** Load all nodes for a session into memory. Throws if no root found. */
  export async function load(sessionId: string, dataHome: string): Promise<Snapshot> {
    const ids = await NodeFS.list(sessionId, dataHome)
    if (ids.length === 0) {
      throw new Error(`freerun tree: session '${sessionId}' has no nodes on disk`)
    }
    const byId = new Map<string, ContextNode>()
    let rootId: string | undefined
    for (const id of ids) {
      const node = await NodeFS.read(sessionId, id, dataHome)
      byId.set(id, node)
      if (node.parent_id === null) {
        if (rootId !== undefined && rootId !== id) {
          throw new Error(`freerun tree: multiple roots found ('${rootId}' and '${id}')`)
        }
        rootId = id
      }
    }
    if (rootId === undefined) {
      throw new Error(`freerun tree: no root node (parent_id=null) found in session '${sessionId}'`)
    }
    return { sessionId, byId, rootId }
  }

  /** Get a node by id; throws if missing. */
  export function get(tree: Snapshot, id: string): ContextNode {
    const node = tree.byId.get(id)
    if (node === undefined) throw new Error(`freerun tree: node '${id}' not found`)
    return node
  }

  /** Total node count (excluding archived nodes). */
  export function size(tree: Snapshot): number {
    return tree.byId.size
  }

  // ============================================================================
  // Traversal
  // ============================================================================

  /**
   * Depth-first preorder iteration starting from `rootId` (or `from` if provided).
   * Order of children matches the order in `node.children_ids`.
   * Stale child references (children_ids pointing at a missing node) are skipped.
   */
  export function* walkDFS(tree: Snapshot, from?: string): Generator<ContextNode> {
    const startId = from ?? tree.rootId
    const stack: string[] = [startId]
    while (stack.length > 0) {
      const id = stack.pop()!
      const node = tree.byId.get(id)
      if (node === undefined) continue
      yield node
      // Push in reverse so leftmost child is popped first → preorder.
      for (let i = node.children_ids.length - 1; i >= 0; i--) {
        stack.push(node.children_ids[i])
      }
    }
  }

  /**
   * Breadth-first iteration starting from `rootId` (or `from` if provided).
   * Yields (node, depth) pairs; depth=0 for the start node.
   */
  export function* walkBFS(tree: Snapshot, from?: string): Generator<{ node: ContextNode; depth: number }> {
    const startId = from ?? tree.rootId
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }]
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!
      const node = tree.byId.get(id)
      if (node === undefined) continue
      yield { node, depth }
      for (const cid of node.children_ids) queue.push({ id: cid, depth: depth + 1 })
    }
  }

  /** Depth of `id` from root (root = 0). Throws if id not found. */
  export function depthOf(tree: Snapshot, id: string): number {
    let cur = get(tree, id)
    let d = 0
    while (cur.parent_id !== null) {
      cur = get(tree, cur.parent_id)
      d++
    }
    return d
  }

  // ============================================================================
  // Relations
  // ============================================================================

  /** Walk parent chain from `id` up to root. Yields nodes from parent up (id itself excluded). */
  export function* ancestors(tree: Snapshot, id: string): Generator<ContextNode> {
    let cur = get(tree, id)
    while (cur.parent_id !== null) {
      const parent = tree.byId.get(cur.parent_id)
      if (parent === undefined) return
      yield parent
      cur = parent
    }
  }

  /** Siblings of `id` (same parent, excluding `id` itself). Empty for root. */
  export function siblings(tree: Snapshot, id: string): ContextNode[] {
    const node = get(tree, id)
    if (node.parent_id === null) return []
    const parent = tree.byId.get(node.parent_id)
    if (parent === undefined) return []
    const out: ContextNode[] = []
    for (const sid of parent.children_ids) {
      if (sid === id) continue
      const s = tree.byId.get(sid)
      if (s !== undefined) out.push(s)
    }
    return out
  }

  /** Direct children of `id` (in declared order). Missing children skipped. */
  export function children(tree: Snapshot, id: string): ContextNode[] {
    const node = get(tree, id)
    const out: ContextNode[] = []
    for (const cid of node.children_ids) {
      const c = tree.byId.get(cid)
      if (c !== undefined) out.push(c)
    }
    return out
  }

  /** Whole subtree rooted at `id`, DFS preorder, including id itself. */
  export function subtree(tree: Snapshot, id: string): ContextNode[] {
    return Array.from(walkDFS(tree, id))
  }

  // ============================================================================
  // Mode-aware queries
  // ============================================================================

  /**
   * Predicate: node still needs iteration work on itself.
   * `decomposed` is excluded — its work was already delegated to children.
   * `done` / `blocked` are terminal.
   */
  export function isActionable(node: ContextNode): boolean {
    return node.mode === "pending-plan" || node.mode === "pending-exec" || node.mode === "doing"
  }

  /**
   * Predicate: a subtree is fully settled.
   * Every node must be in a terminal-or-delegated mode (`decomposed`, `done`, or `blocked`).
   * In other words, nothing in the subtree is still actionable.
   */
  export function isSubtreeComplete(tree: Snapshot, id: string): boolean {
    for (const n of walkDFS(tree, id)) {
      if (isActionable(n)) return false
    }
    return true
  }

  /** All nodes with the given mode, in DFS preorder. */
  export function findByMode(tree: Snapshot, mode: NodeMode): ContextNode[] {
    const out: ContextNode[] = []
    for (const n of walkDFS(tree)) if (n.mode === mode) out.push(n)
    return out
  }

  /**
   * BFS-plan-to-depth-N then DFS preorder (DD-3b).
   * Phase A: shallowest `pending-plan` at depth ≤ topLevelsToPlan.
   * Phase B: leftmost unfinished (non-done/non-blocked) in DFS preorder.
   * Returns null only when the whole tree is settled.
   */
  export function pickNext(tree: Snapshot, topLevelsToPlan: number): ContextNode | null {
    // Phase A — shallowest pending-plan at depth ≤ N.
    let bestPlan: { node: ContextNode; depth: number } | null = null
    for (const { node, depth } of walkBFS(tree)) {
      if (depth > topLevelsToPlan) break // BFS yields in non-decreasing depth → safe early exit
      if (node.mode === "pending-plan") {
        if (bestPlan === null || depth < bestPlan.depth) {
          bestPlan = { node, depth }
          if (depth === 0) break // root pending-plan dominates
        }
      }
    }
    if (bestPlan !== null) return bestPlan.node

    // Phase B — leftmost actionable in DFS preorder.
    for (const n of walkDFS(tree)) {
      if (isActionable(n)) return n
    }
    return null
  }

  // ============================================================================
  // Archive (consolidation, DD-3c)
  // ============================================================================

  /**
   * Move every node in a subtree into `tree/.archive/<stamp>/`. The root of the
   * subtree itself is NOT archived (it stays in place; consolidation overwrites
   * its body with the summary). Children files are physically moved.
   *
   * Caller is responsible for clearing the root's `children_ids` and writing
   * the consolidated summary BEFORE invoking archive, so the on-disk tree never
   * references nodes that no longer exist at the canonical path.
   */
  export async function archiveSubtree(
    tree: Snapshot,
    rootId: string,
    archiveStamp: string,
    dataHome: string,
  ): Promise<string[]> {
    const root = get(tree, rootId)
    const archived: string[] = []
    // Collect descendants in DFS preorder, then archive children-first to keep
    // each archive operation a simple file move.
    const descendants: string[] = []
    for (const n of walkDFS(tree, rootId)) {
      if (n.id === rootId) continue
      descendants.push(n.id)
    }
    // children-first archive order (reverse DFS preorder ≈ post-order-ish for
    // file moves; we don't strictly need this because archive() is a single
    // rename on each file, but reversing avoids any later look-ups against
    // already-moved parents).
    descendants.reverse()
    for (const id of descendants) {
      await NodeFS.archive(tree.sessionId, id, archiveStamp, dataHome)
      archived.push(id)
    }
    // Suppress unused-warning while leaving the parent reference accessible for
    // future callers (e.g. if we want to copy the root's pre-archive body too).
    void root
    return archived
  }

  /** Convenience: list archived stamps for a session. */
  export async function listArchiveStamps(sessionId: string, dataHome: string): Promise<string[]> {
    const archiveDir = path.join(sessionStorageDir(sessionId, dataHome), "tree", ".archive")
    try {
      const entries = await fs.readdir(archiveDir, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    } catch (err: any) {
      if (err?.code === "ENOENT") return []
      throw err
    }
  }
}
