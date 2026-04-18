import { Todo } from "./todo"

/**
 * RunTrigger — represents an intent to start or continue work in a session.
 * The runloop is a pure todolist engine, so the trigger is just a carrier
 * for the text to inject plus (for continuations) the associated todo.
 */
export type RunTrigger = RunTrigger.Continuation | RunTrigger.Api | RunTrigger.Cron

export namespace RunTrigger {
  export type Continuation = {
    type: "continuation"
    source: "todo_pending" | "todo_in_progress"
    payload: { text: string; todo: Todo.Info }
    priority: TriggerPriority
  }

  export type Api = {
    type: "api"
    source: string
    payload: { text: string; todo?: Todo.Info; apiContext?: Record<string, unknown> }
    priority: TriggerPriority
  }

  export type Cron = {
    type: "cron"
    source: "scheduled" | "heartbeat"
    payload: { text: string; jobId: string; runId: string; lightContext: boolean }
    priority: TriggerPriority
  }
}

export type TriggerPriority = "critical" | "normal" | "background"

/**
 * Build a continuation trigger from todo state.
 * Returns undefined if no actionable todo exists (todo_complete path).
 */
export function buildContinuationTrigger(input: {
  todo: Todo.Info | undefined
  textForPending: string
  textForInProgress: string
}): RunTrigger.Continuation | undefined {
  if (!input.todo) return undefined
  if (input.todo.status === "in_progress") {
    return {
      type: "continuation",
      source: "todo_in_progress",
      payload: { text: input.textForInProgress, todo: input.todo },
      priority: "normal",
    }
  }
  if (input.todo.status === "pending") {
    return {
      type: "continuation",
      source: "todo_pending",
      payload: { text: input.textForPending, todo: input.todo },
      priority: "normal",
    }
  }
  return undefined
}

export function buildApiTrigger(input: {
  source: string
  text: string
  todo?: Todo.Info
  priority?: TriggerPriority
  apiContext?: Record<string, unknown>
}): RunTrigger.Api {
  return {
    type: "api",
    source: input.source,
    payload: { text: input.text, todo: input.todo, apiContext: input.apiContext },
    priority: input.priority ?? "normal",
  }
}

export function buildCronTrigger(input: {
  source: "scheduled" | "heartbeat"
  text: string
  jobId: string
  runId: string
  lightContext?: boolean
  priority?: TriggerPriority
}): RunTrigger.Cron {
  return {
    type: "cron",
    source: input.source,
    payload: {
      text: input.text,
      jobId: input.jobId,
      runId: input.runId,
      lightContext: input.lightContext ?? false,
    },
    priority: input.priority ?? "background",
  }
}
