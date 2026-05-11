import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

// LLM-facing todo shape. The full `Todo.Info` carries an `action` metadata
// block (kind/risk/waitingOn/...) used by autonomous-mode permission gates,
// but exposing it to the LLM made todowrite a recurring schema trap: the
// model would fill `action` partially or with off-enum values and the call
// would fail validation. The runtime infers action from `content` via
// `Todo.enrichAll`, so the LLM only needs to send the four primitives.
const LLMTodoShape = z.object({
  content: z.string().describe("Brief description of the task"),
  status: z.string().describe("pending | in_progress | completed | cancelled"),
  priority: z.string().optional().default("medium").describe("high | medium | low (defaults to medium)"),
  // CACHE FIX 2026-05-11: `.default(() => ...)` is evaluated by zod-to-
  // json-schema at serialization time, producing a NEW timestamp+random
  // string every request. That mutates the tools[] JSON bytes per turn
  // and shatters codex prefix cache (RCA: plans/provider_codex-prompt-
  // realign cache-4608-floor investigation 2026-05-11). Use a stable
  // literal default — the actual id is filled in by the execute() body
  // after parsing if absent.
  id: z
    .string()
    .optional()
    .describe("Stable id for the todo (auto-generated if omitted)"),
})

export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    mode: z
      .enum(["status_update", "plan_materialization", "replan_adoption"])
      .optional()
      .describe(
        "Why this update is happening. status_update = progress/status only (no structure drift). plan_materialization/replan_adoption allow explicit structure changes from planner artifacts. The runtime auto-promotes status_update to working_ledger when structure changes are detected, so you may omit this field.",
      ),
    todos: z
      .array(LLMTodoShape)
      .describe("The updated todo list. Send only content/status/priority/id; action metadata is inferred server-side."),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    // Server-generate id when the LLM omits it (CACHE FIX 2026-05-11:
    // schema no longer carries a dynamic default — see LLMTodoShape.id).
    const incoming: Todo.Info[] = params.todos.map((todo) => ({
      ...todo,
      id: todo.id ?? `todo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    })) as Todo.Info[]
    const current = await Todo.get(ctx.sessionID)

    const signature = (todos: Todo.Info[]) =>
      todos
        .map((todo) => `${todo.id}::${todo.content.trim().toLowerCase().replace(/\s+/g, " ")}`)
        .sort()
        .join("||")

    const structureChanged = signature(current) !== signature(incoming)

    // Harness control (plan-builder skill, agent prompts) decides when structure
    // edits are appropriate; the runtime just honors what the LLM passes. The
    // one universal rule: if status_update was passed but the structure actually
    // changed, promote to working_ledger so the new structure isn't silently
    // dropped by applyStatusOnlyUpdate.
    let mode: Todo.UpdateMode = params.mode ?? "status_update"
    if (mode === "status_update" && structureChanged) {
      mode = "working_ledger"
    }

    await Todo.update({
      sessionID: ctx.sessionID,
      todos: incoming,
      mode,
    })
    const todos = await Todo.get(ctx.sessionID)
    return {
      title: `${todos.filter((x) => x.status !== "completed").length} todos`,
      output: JSON.stringify(todos, null, 2),
      metadata: {
        todos,
      },
    }
  },
})

export const TodoReadTool = Tool.define("todoread", {
  description: "Use this tool to read your todo list",
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "todoread",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const todos = await Todo.get(ctx.sessionID)
    return {
      title: `${todos.filter((x) => x.status !== "completed").length} todos`,
      metadata: {
        todos,
      },
      output: JSON.stringify(todos, null, 2),
    }
  },
})
