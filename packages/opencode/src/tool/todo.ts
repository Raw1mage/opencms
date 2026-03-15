import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    mode: z
      .enum(["status_update", "plan_materialization", "replan_adoption"])
      .optional()
      .describe(
        "Why this update is happening. status_update = progress/status only (no structure drift). plan_materialization/replan_adoption allow explicit structure changes from planner artifacts.",
      ),
    todos: z
      .array(z.object(Todo.Info.shape))
      .describe(
        "The updated todo list. Prefer supplying structured action metadata (kind/risk/needsApproval/canDelegate/waitingOn) when known.",
      ),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const mode = params.mode ?? "status_update"
    const current = await Todo.get(ctx.sessionID)

    const signature = (todos: Todo.Info[]) =>
      todos
        .map((todo) => `${todo.id}::${todo.content.trim().toLowerCase().replace(/\s+/g, " ")}`)
        .sort()
        .join("||")

    const currentSignature = signature(current)
    const incomingSignature = signature(params.todos)
    const structureChanged = currentSignature !== incomingSignature

    if (mode === "status_update" && structureChanged && current.length > 0) {
      throw new Error(
        "todowrite(status_update) cannot rewrite todo structure. Use mode=plan_materialization or mode=replan_adoption only when planner artifacts changed or a replan was explicitly adopted.",
      )
    }

    await Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
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
