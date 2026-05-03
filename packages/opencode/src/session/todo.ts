import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Storage } from "../storage/storage"

export namespace Todo {
  export const UpdateMode = z.enum(["status_update", "plan_materialization", "replan_adoption", "working_ledger"])
  export type UpdateMode = z.infer<typeof UpdateMode>

  export const Action = z
    .object({
      kind: z.enum([
        "implement",
        "delegate",
        "wait",
        "approval",
        "decision",
        "push",
        "destructive",
        "architecture_change",
      ]),
      risk: z.enum(["low", "medium", "high"]).optional(),
      needsApproval: z.boolean().optional(),
      canDelegate: z.boolean().optional(),
      waitingOn: z
        .enum(["subagent", "approval", "decision", "external"])
        .optional()
        .catch(undefined),
      dependsOn: z.array(z.string()).optional(),
    })
    .optional()
    .describe("Structured planner metadata for autonomous session execution")
  export type Action = z.infer<typeof Action>

  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
      priority: z
        .string()
        .optional()
        .default("medium")
        .describe("Priority level of the task: high, medium, low (defaults to medium if omitted)"),
      id: z
        .string()
        .optional()
        .default(() => `todo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`)
        .describe("Unique identifier for the todo item (auto-generated if omitted)"),
      action: Action,
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: z.string(),
        todos: z.array(Info),
      }),
    ),
  }

  export function inferActionFromContent(todo: Pick<Info, "content" | "status">): Action {
    const text = todo.content.toLowerCase()
    if (text.includes("push") || text.includes("deploy") || text.includes("release") || text.includes("publish")) {
      return { kind: "push", risk: "high", needsApproval: true }
    }
    if (
      text.includes("delete") ||
      text.includes("remove") ||
      text.includes("drop ") ||
      text.includes("reset") ||
      text.includes("destroy")
    ) {
      return { kind: "destructive", risk: "high", needsApproval: true }
    }
    if (
      text.includes("architecture") ||
      text.includes("refactor") ||
      text.includes("schema") ||
      text.includes("migration") ||
      text.includes("breaking change")
    ) {
      return { kind: "architecture_change", risk: "high", needsApproval: true }
    }
    if (text.includes("wait for") || text.includes("blocked by") || text.includes("waiting on")) {
      if (text.includes("subagent") || text.includes("worker")) return { kind: "wait", waitingOn: "subagent" }
      if (text.includes("approval")) return { kind: "approval", waitingOn: "approval", needsApproval: true }
      if (text.includes("decision")) return { kind: "decision", waitingOn: "decision" }
      return { kind: "wait", waitingOn: "external" }
    }
    if (text.includes("delegate") || text.includes("subagent") || text.includes("hand off")) {
      return { kind: "delegate", canDelegate: true }
    }
    return { kind: "implement", canDelegate: todo.status === "pending" ? true : undefined }
  }

  export function enrich(input: Info): Info {
    return {
      ...input,
      action: input.action ?? inferActionFromContent(input),
    }
  }

  export function enrichAll(todos: Info[]) {
    return todos.map(enrich)
  }

  function normalizeContent(content: string) {
    return content.trim().toLowerCase().replace(/\s+/g, " ")
  }

  function mergePreservingProgress(current: Info[], incoming: Info[]) {
    if (!current.length) return enrichAll(incoming)
    if (!incoming.length) return []

    const enrichedCurrent = enrichAll(current)
    const enrichedIncoming = enrichAll(incoming)
    const currentByID = new Map(enrichedCurrent.map((todo) => [todo.id, todo]))
    const currentByContent = new Map(enrichedCurrent.map((todo) => [normalizeContent(todo.content), todo]))

    let overlap = 0
    for (const todo of enrichedIncoming) {
      if (currentByID.has(todo.id) || currentByContent.has(normalizeContent(todo.content))) overlap += 1
    }

    if (overlap === 0) return enrichedIncoming

    return enrichedIncoming.map((todo) => {
      const previous = currentByID.get(todo.id) ?? currentByContent.get(normalizeContent(todo.content))
      if (!previous) return todo
      if (previous.status === "completed" || previous.status === "cancelled") {
        return {
          ...todo,
          status: previous.status,
          action: previous.action ?? todo.action,
        }
      }
      if (previous.status === "in_progress" && todo.status === "pending") {
        return {
          ...todo,
          status: "in_progress",
          action: previous.action ?? todo.action,
        }
      }
      return todo
    })
  }

  function projectProgressOntoSeed(current: Info[], seed: Info[]) {
    if (!seed.length) return []
    if (!current.length) return enrichAll(seed)

    const enrichedCurrent = enrichAll(current)
    const enrichedSeed = enrichAll(seed)
    const currentByID = new Map(enrichedCurrent.map((todo) => [todo.id, todo]))
    const currentByContent = new Map(enrichedCurrent.map((todo) => [normalizeContent(todo.content), todo]))

    return enrichedSeed.map((todo, index) => {
      const previous = currentByID.get(todo.id) ?? currentByContent.get(normalizeContent(todo.content))
      if (!previous) return todo
      if (previous.status === "completed" || previous.status === "cancelled") {
        return {
          ...todo,
          status: previous.status,
          action: previous.action ?? todo.action,
        }
      }
      if (previous.status === "in_progress") {
        return {
          ...todo,
          status: "in_progress",
          action: previous.action ?? todo.action,
        }
      }
      return {
        ...todo,
        action: previous.action ?? todo.action,
      }
    })
  }

  function applyStatusOnlyUpdate(current: Info[], incoming: Info[]) {
    const enrichedCurrent = enrichAll(current)
    const enrichedIncoming = enrichAll(incoming)
    const currentByID = new Map(enrichedCurrent.map((todo) => [todo.id, todo]))
    const currentByContent = new Map(enrichedCurrent.map((todo) => [normalizeContent(todo.content), todo]))

    return enrichedCurrent.map((todo) => {
      const incomingTodo = enrichedIncoming.find(
        (candidate) =>
          candidate.id === todo.id || normalizeContent(candidate.content) === normalizeContent(todo.content),
      )
      if (!incomingTodo) return todo
      return {
        ...todo,
        status: incomingTodo.status,
        priority: incomingTodo.priority ?? todo.priority,
        action: incomingTodo.action ?? todo.action,
      }
    })
  }

  export function projectSeedWithProgress(current: Info[], seed: Info[]) {
    return projectProgressOntoSeed(current, seed)
  }

  export function sameStructure(a: Info[], b: Info[]) {
    const signature = (todos: Info[]) =>
      todos
        .map((todo) => `${todo.id}::${normalizeContent(todo.content)}`)
        .sort()
        .join("||")
    return signature(a) === signature(b)
  }

  export function isDependencyReady(todo: Info, todos: Info[]) {
    const deps = todo.action?.dependsOn
    if (!deps?.length) return true
    return deps.every((id) => todos.find((candidate) => candidate.id === id)?.status === "completed")
  }

  export function nextActionableTodo(todos: Info[]) {
    return (
      todos.find((todo) => todo.status === "in_progress") ??
      todos.find((todo) => todo.status === "pending" && isDependencyReady(todo, todos))
    )
  }

  export function applyHostAdoptedReplan(
    todos: Info[],
    proposal?: {
      targetTodoID?: string
      proposedAction?: string
      policy?: {
        adoptionMode?: string
        requiresUserConfirm?: boolean
        requiresHostReview?: boolean
      }
    },
  ) {
    if (!proposal?.targetTodoID) return { adopted: false as const, reason: "missing_target" as const, todos }
    if (proposal.proposedAction !== "replan_todos")
      return { adopted: false as const, reason: "unsupported_action" as const, todos }
    if (proposal.policy?.adoptionMode !== "host_adoptable")
      return { adopted: false as const, reason: "policy_not_host_adoptable" as const, todos }
    if (proposal.policy?.requiresUserConfirm)
      return { adopted: false as const, reason: "user_confirm_required" as const, todos }
    if (proposal.policy?.requiresHostReview === false)
      return { adopted: false as const, reason: "host_review_missing" as const, todos }
    if (todos.some((todo) => todo.status === "in_progress"))
      return { adopted: false as const, reason: "active_todo_in_progress" as const, todos }

    const enriched = enrichAll(todos)
    const target = enriched.find((todo) => todo.id === proposal.targetTodoID)
    if (!target || target.status !== "pending")
      return { adopted: false as const, reason: "target_not_pending" as const, todos: enriched }
    if (!isDependencyReady(target, enriched))
      return { adopted: false as const, reason: "dependencies_not_ready" as const, todos: enriched }
    if (target.action?.needsApproval)
      return { adopted: false as const, reason: "approval_gate" as const, todos: enriched }
    if (target.action?.waitingOn) return { adopted: false as const, reason: "waiting_gate" as const, todos: enriched }
    if (target.action?.kind && target.action.kind !== "implement")
      return { adopted: false as const, reason: "unsupported_todo_kind" as const, todos: enriched }

    return {
      adopted: true as const,
      adoptedTodoID: target.id,
      reason: "adopted" as const,
      todos: enriched.map((todo) => (todo.id === target.id ? { ...todo, status: "in_progress" } : todo)),
    }
  }

  export function applyHostAdoptedCompletion(
    todos: Info[],
    proposal?: {
      targetTodoID?: string
      proposedAction?: string
      policy?: {
        adoptionMode?: string
        requiresUserConfirm?: boolean
        requiresHostReview?: boolean
      }
    },
  ) {
    if (!proposal?.targetTodoID) return { adopted: false as const, reason: "missing_target" as const, todos }
    if (proposal.proposedAction !== "mark_todo_complete")
      return { adopted: false as const, reason: "unsupported_action" as const, todos }
    if (proposal.policy?.adoptionMode !== "host_adoptable")
      return { adopted: false as const, reason: "policy_not_host_adoptable" as const, todos }
    if (proposal.policy?.requiresUserConfirm)
      return { adopted: false as const, reason: "user_confirm_required" as const, todos }
    if (proposal.policy?.requiresHostReview === false)
      return { adopted: false as const, reason: "host_review_missing" as const, todos }

    const enriched = enrichAll(todos)
    const target = enriched.find((todo) => todo.id === proposal.targetTodoID)
    if (!target) return { adopted: false as const, reason: "missing_target" as const, todos: enriched }
    if (target.status === "completed" || target.status === "cancelled")
      return { adopted: false as const, reason: "target_not_active" as const, todos: enriched }
    if (target.action?.needsApproval)
      return { adopted: false as const, reason: "approval_gate" as const, todos: enriched }
    if (target.action?.waitingOn) return { adopted: false as const, reason: "waiting_gate" as const, todos: enriched }

    const current = nextActionableTodo(enriched)
    if (!current || current.id !== target.id)
      return { adopted: false as const, reason: "target_not_active" as const, todos: enriched }

    return {
      adopted: true as const,
      adoptedTodoID: target.id,
      reason: "adopted" as const,
      todos: enriched.map((todo) => (todo.id === target.id ? { ...todo, status: "completed" } : todo)),
    }
  }

  export async function reconcileProgress(input: {
    sessionID: string
    linkedTodoID?: string
    taskStatus: "returned" | "completed" | "error"
  }) {
    const current = await get(input.sessionID)
    if (!current.length) return current

    // Defer to AI on the force-overwrite path: if AI has already marked
    // the linked todo as completed or cancelled (via its own TodoWrite
    // while the subagent was running), runtime must not snatch it back.
    // Only "completed" is force-overwriting; "returned"/"error" preserve
    // existing non-pending status, so they don't need the guard.
    if (input.linkedTodoID && input.taskStatus === "completed") {
      const linked = current.find((todo) => todo.id === input.linkedTodoID)
      if (linked && (linked.status === "completed" || linked.status === "cancelled")) {
        return current
      }
    }

    const todos = enrichAll(
      current.map((todo) => {
        if (input.linkedTodoID && todo.id === input.linkedTodoID) {
          if (input.taskStatus === "returned") {
            return {
              ...todo,
              status: todo.status === "pending" ? "in_progress" : todo.status,
              action: todo.action?.waitingOn === "subagent" ? { ...todo.action, waitingOn: undefined } : todo.action,
            }
          }
          if (input.taskStatus === "completed") {
            return {
              ...todo,
              status: "completed",
              action: todo.action?.waitingOn === "subagent" ? { ...todo.action, waitingOn: undefined } : todo.action,
            }
          }
          return {
            ...todo,
            status: todo.status === "pending" ? "in_progress" : todo.status,
            action:
              todo.action && todo.action.waitingOn !== "subagent"
                ? { ...todo.action, waitingOn: "subagent" }
                : (todo.action ?? { kind: "wait", waitingOn: "subagent" }),
          }
        }
        return todo
      }),
    )

    if (input.taskStatus === "completed" && !todos.some((todo) => todo.status === "in_progress")) {
      const next = nextActionableTodo(todos)
      if (next && next.status === "pending") {
        const index = todos.findIndex((todo) => todo.id === next.id)
        if (index >= 0) todos[index] = { ...todos[index], status: "in_progress" }
      }
    }

    await update({ sessionID: input.sessionID, todos, mode: "status_update" })
    return todos
  }

  export async function update(input: { sessionID: string; todos: Info[]; mode?: UpdateMode }) {
    const current = await get(input.sessionID)
    const mode = input.mode ?? "replan_adoption"
    const todos =
      mode === "working_ledger"
        ? enrichAll(input.todos)
        : mode === "status_update"
          ? applyStatusOnlyUpdate(current, input.todos)
          : mode === "plan_materialization"
            ? projectProgressOntoSeed(current, input.todos)
            : mergePreservingProgress(current, input.todos)
    await Storage.write(["todo", input.sessionID], todos)
    Bus.publish(Event.Updated, {
      sessionID: input.sessionID,
      todos,
    })
  }

  export async function get(sessionID: string) {
    return Storage.read<Info[]>(["todo", sessionID])
      .then((x) => x || [])
      .catch(() => [])
  }

  export async function setDerived(input: { sessionID: string; todos: Info[] }) {
    const todos = enrichAll(input.todos)
    await Storage.write(["todo", input.sessionID], todos)
    Bus.publish(Event.Updated, {
      sessionID: input.sessionID,
      todos,
    })
    return todos
  }
}
