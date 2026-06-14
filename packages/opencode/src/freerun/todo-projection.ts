import type { Todo } from "../session/todo"
import { Tree } from "./storage/tree"
import type { ContextNode } from "./types"

export namespace FreerunTodoProjection {
  export function project(tree: Tree.Snapshot): Todo.Info[] {
    const root = Tree.get(tree, tree.rootId)
    const active = Tree.pickNext(tree, 3)
    const nodes = visibleNodes(tree, root, active)
    return nodes.map((node) => toTodo(tree, node, active))
  }

  function toTodo(tree: Tree.Snapshot, node: ContextNode, active: ContextNode | null): Todo.Info {
    const stop = stopKind(node)
    return {
      id: `freerun:${node.id}`,
      content: stop ? `${node.id} [${stop}] ${node.title}` : `${node.id} ${node.title}`,
      status: statusFor(tree, node, active),
      priority: node.parent_id === null ? "high" : "medium",
      action: actionFor(stop),
    }
  }

  function visibleNodes(tree: Tree.Snapshot, root: ContextNode, active: ContextNode | null): ContextNode[] {
    const ordered = new Map<string, ContextNode>()
    const rootChildren = Tree.children(tree, root.id)
    for (const node of rootChildren.length > 0 ? rootChildren : [root]) ordered.set(node.id, node)
    if (active) {
      ordered.set(active.id, active)
      const parent = active.parent_id ? Tree.get(tree, active.parent_id) : undefined
      for (const sibling of parent ? Tree.children(tree, parent.id) : []) ordered.set(sibling.id, sibling)
      for (const child of Tree.children(tree, active.id)) ordered.set(child.id, child)
    }
    return Array.from(ordered.values())
  }

  function statusFor(tree: Tree.Snapshot, node: ContextNode, active: ContextNode | null): string {
    if (node.mode === "done") return "completed"
    const stop = stopKind(node)
    if (stop) return stop
    if (active && (active.id === node.id || isAncestorOf(tree, node.id, active.id))) return "in_progress"
    if (node.mode === "decomposed" && Tree.isSubtreeComplete(tree, node.id)) return "completed"
    return "pending"
  }

  function actionFor(stop: "decision" | "approval" | "blocked" | undefined): Todo.Action {
    if (stop === "decision") return { kind: "decision", waitingOn: "decision", canDelegate: false }
    if (stop === "approval") return { kind: "approval", waitingOn: "approval", needsApproval: true, canDelegate: false }
    if (stop === "blocked") return { kind: "wait", waitingOn: "external", canDelegate: false }
    return { kind: "implement", canDelegate: false }
  }

  function stopKind(node: ContextNode): "decision" | "approval" | "blocked" | undefined {
    const blockers = node.blockers.join("\n")
    if (/approval|approve|批准|核准/i.test(blockers)) return "approval"
    if (/decision|decide|決策|決定/i.test(blockers)) return "decision"
    if (node.mode === "blocked") return "blocked"
    return undefined
  }

  function isAncestorOf(tree: Tree.Snapshot, ancestorId: string, childId: string): boolean {
    for (const ancestor of Tree.ancestors(tree, childId)) {
      if (ancestor.id === ancestorId) return true
    }
    return false
  }
}
