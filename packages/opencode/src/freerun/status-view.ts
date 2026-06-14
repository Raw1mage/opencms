import type { Todo } from "../session/todo"
import type { FreerunMetricsSummary } from "./observability/metrics"
import { Tree } from "./storage/tree"

export interface StatusViewInput {
  sessionID: string
  tree: Tree.Snapshot
  projectedTodos: Todo.Info[]
  metrics: FreerunMetricsSummary
}

export function renderFreerunStatusView(input: StatusViewInput): string {
  const root = Tree.get(input.tree, input.tree.rootId)
  const active = Tree.pickNext(input.tree, 3)
  const lines = [
    `session: ${input.sessionID}`,
    `active_root: ${root.id} [${root.mode}] ${root.title}`,
    `current_path: ${
      active
        ? Array.from(Tree.ancestors(input.tree, active.id))
            .reverse()
            .map((node) => node.id)
            .concat(active.id)
            .join(" > ")
        : "(settled)"
    }`,
    `nodes: ${Tree.size(input.tree)}`,
    "",
    "projected_todos:",
  ]

  if (input.projectedTodos.length === 0) lines.push("- (none)")
  for (const todo of input.projectedTodos) lines.push(`- [${todo.status}] ${todo.id} ${todo.content}`)

  lines.push(
    "",
    "metrics:",
    `- planning_validation_failures: ${input.metrics.planningValidationFailures}`,
    `- no_meta_icom_rejects: ${input.metrics.noMetaIcomRejects}`,
    `- pick_next_decisions: ${input.metrics.pickNextDecisions}`,
    `- node_transitions: ${input.metrics.nodeTransitions}`,
    `- consolidation_events: ${input.metrics.consolidationEvents}`,
    "",
    "recent_validation_errors:",
  )
  if (input.metrics.recentValidationErrors.length === 0) lines.push("- (none)")
  for (const error of input.metrics.recentValidationErrors) lines.push(`- ${error}`)
  return lines.join("\n")
}
