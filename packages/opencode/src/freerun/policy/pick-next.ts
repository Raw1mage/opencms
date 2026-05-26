/**
 * harness/freerun-mode — DD-3b pick-next policy.
 *
 * Public entry for the iteration scheduler. The core BFS-plan-to-depth-N
 * then DFS algorithm lives in `Tree.pickNext` (storage layer) because it
 * operates purely on a Tree.Snapshot. This module owns the policy-level
 * concerns:
 *   - reading `top_levels_to_plan` from ExperimentConfig
 *   - returning a discriminated outcome so the engine can branch cleanly
 */

import { Tree } from "../storage/tree"
import type { ContextNode, ExperimentConfig } from "../types"

export namespace PickNext {
  /** Discriminated outcome — lets the engine differentiate "tree settled" from "got node". */
  export type Outcome =
    | { kind: "node"; node: ContextNode }
    | { kind: "settled" } // nothing left to act on; engine should terminate / consolidate

  export function pick(tree: Tree.Snapshot, config: Pick<ExperimentConfig, "top_levels_to_plan">): Outcome {
    const node = Tree.pickNext(tree, config.top_levels_to_plan)
    if (node === null) return { kind: "settled" }
    return { kind: "node", node }
  }
}
