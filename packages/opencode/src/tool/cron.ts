import z from "zod"
import { Tool } from "./tool"
import { CronStore } from "../cron/store"
import { RunLog } from "../cron/run-log"
import { Schedule } from "../cron/schedule"
import { CronSession } from "../cron/session"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.cron" })

const CronScheduleParam = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("at"),
    at: z
      .string()
      .describe(
        "One-shot ISO 8601 timestamp for a single deferred run, e.g. '2026-06-09T15:00:00+08:00'. Runs once at that moment, then settles.",
      ),
  }),
  z.object({
    kind: z.literal("cron"),
    expr: z
      .string()
      .describe("5-field crontab expression (min hour dom mon dow). Example: '*/30 * * * *' for every 30 minutes"),
    tz: z.string().optional().describe("IANA timezone, e.g. 'Asia/Taipei'. Defaults to system timezone"),
  }),
  z.object({
    kind: z.literal("every"),
    everyMs: z.number().int().positive().describe("Interval in milliseconds"),
  }),
])

// ── CronCreate ──────────────────────────────────────────────────────

export const CronCreateTool = Tool.define("cron_create", {
  description: `Schedule a deferred prompt to run at a future time, in a dedicated subsession, while the current conversation continues untouched.

Use this when work should happen later rather than now — e.g. "at 3pm summarize today's commits" (one-shot), "check my email every 30 minutes", "monitor stock alerts every hour" (recurring).

Schedule kinds:
- 'at': run ONCE at a specific ISO timestamp (a single deferred task).
- 'cron' / 'every': run on a recurring schedule.

A task-management subsession is created immediately (it appears in the Scheduled Tasks sidebar and is openable right away), holds the deferred prompt, and stays dormant — the prompt is only sent to the AI when its scheduled time arrives. Each run uses lightweight context, so make the prompt self-contained.

After creating the task, tell the user they can see and manage it from the Tasks panel in the sidebar.`,
  parameters: z.object({
    name: z.string().min(1).describe("Short descriptive name for the task, e.g. 'Check stock alerts'"),
    description: z.string().optional().describe("Optional longer description of what this task does"),
    prompt: z
      .string()
      .min(1)
      .describe(
        "The self-contained prompt sent to the AI at fire time. Be specific about what to do and which tools/MCP servers to use — the run does not inherit this conversation's context.",
      ),
    schedule: CronScheduleParam.describe("When to run: 'at' for a one-shot ISO timestamp, or 'cron'/'every' for recurring."),
    enabled: z.boolean().default(true).describe("Whether the task starts enabled immediately"),
  }),
  async execute(params, ctx) {
    // harness/scheduled-subsession DD-5: lineage — the run is a child of the conversation that scheduled it.
    const parentID = ctx.sessionID
    const job = await CronStore.create({
      name: params.name,
      description: params.description,
      enabled: params.enabled,
      schedule: params.schedule,
      parentID,
      payload: {
        kind: "agentTurn",
        message: params.prompt,
        lightContext: true,
      },
      sessionTarget: "isolated",
      wakeMode: "now",
    })

    const nextRun = Schedule.computeNextRunAtMs(params.schedule, Date.now())

    // harness/scheduled-subsession DD-2: eagerly create the dormant subsession so the task is
    // immediately visible/openable/editable. The heartbeat fires this session at its scheduled time.
    let dormantSessionID: string | undefined
    try {
      dormantSessionID = await CronSession.createDormant({
        jobId: job.id,
        name: params.name,
        parentID,
        fireAtMs: nextRun ?? Date.now(),
      })
      await CronStore.update(job.id, { dormantSessionID })
    } catch (e) {
      // Non-fatal: the schedule itself is persisted; lazy materialization still works as a fallback.
      log.error("createDormant failed", { jobId: job.id, error: e })
    }

    const nextRunStr = nextRun ? new Date(nextRun).toLocaleString() : "unknown"

    return {
      title: `Scheduled task "${params.name}"`,
      output: [
        `Scheduled task created successfully.`,
        ``,
        `- **ID**: ${job.id}`,
        `- **Name**: ${job.name}`,
        params.description ? `- **Description**: ${params.description}` : null,
        `- **Schedule**: ${formatSchedule(params.schedule)}`,
        `- **Next run**: ${nextRunStr}`,
        `- **Enabled**: ${params.enabled ? "yes" : "no"}`,
        dormantSessionID ? `- **Task subsession**: ${dormantSessionID} (open from the Tasks panel to inspect/edit)` : null,
        `- **Prompt**: ${params.prompt.slice(0, 200)}${params.prompt.length > 200 ? "..." : ""}`,
        ``,
        `The task is now visible in the Scheduled Tasks panel (sidebar checklist icon).`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { jobId: job.id, dormantSessionID },
    }
  },
})

// ── CronList ────────────────────────────────────────────────────────

export const CronListTool = Tool.define("cron_list", {
  description: `List all scheduled tasks (cron jobs). Shows each task's name, schedule, status, and recent run info. Use this to check what recurring tasks exist before creating new ones or when the user asks about their scheduled workflows.`,
  parameters: z.object({}),
  async execute() {
    const jobs = await CronStore.list()

    if (jobs.length === 0) {
      return {
        title: "No scheduled tasks",
        output: "No scheduled tasks exist. Use cron_create to set up a new recurring task.",
        metadata: { count: 0 },
      }
    }

    const lines = jobs.map((job) => {
      const status = !job.enabled
        ? "disabled"
        : job.state.lastRunStatus === "error"
          ? "error"
          : job.state.lastRunStatus === "ok"
            ? "ok"
            : "pending"
      const nextRun = job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString() : "—"
      const lastRun = job.state.lastRunAtMs ? new Date(job.state.lastRunAtMs).toLocaleString() : "never"
      const errors = job.state.consecutiveErrors ?? 0
      const prompt =
        job.payload.kind === "agentTurn"
          ? job.payload.message
          : job.payload.kind === "systemEvent"
            ? job.payload.text
            : ""

      return [
        `### ${job.name} (${status})`,
        `- **ID**: ${job.id}`,
        job.description ? `- **Description**: ${job.description}` : null,
        `- **Schedule**: ${formatSchedule(job.schedule)}`,
        `- **Next run**: ${nextRun}`,
        `- **Last run**: ${lastRun}`,
        errors > 0 ? `- **Consecutive errors**: ${errors}` : null,
        `- **Prompt**: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`,
      ]
        .filter(Boolean)
        .join("\n")
    })

    return {
      title: `${jobs.length} scheduled task(s)`,
      output: lines.join("\n\n"),
      metadata: { count: jobs.length },
    }
  },
})

// ── CronDelete ──────────────────────────────────────────────────────

export const CronDeleteTool = Tool.define("cron_delete", {
  description: `Delete a scheduled task (cron job) by ID. Use cron_list first to find the task ID. This permanently removes the task and its run history.`,
  parameters: z.object({
    id: z.string().describe("The task ID to delete (UUID format)"),
  }),
  async execute(params): Promise<{ title: string; output: string; metadata: { found: boolean; name?: string } }> {
    const job = await CronStore.get(params.id)
    if (!job) {
      return {
        title: "Task not found",
        output: `No scheduled task found with ID "${params.id}". Use cron_list to see available tasks.`,
        metadata: { found: false },
      }
    }

    await CronStore.remove(params.id)
    await RunLog.removeForJob(params.id)

    return {
      title: `Deleted task "${job.name}"`,
      output: `Scheduled task "${job.name}" (${params.id}) has been deleted along with its run history.`,
      metadata: { found: true, name: job.name },
    }
  },
})

// ── CronUpdate (pre-fire edit) ──────────────────────────────────────

export const CronUpdateTool = Tool.define("cron_update", {
  description: `Edit a pending scheduled task BEFORE it fires — change its schedule and/or its prompt.

Use this to adjust a task you (or the user) previously scheduled: move the time, change the instruction, or both. Find the task id with cron_status or cron_list. Editing only applies before the task fires; a one-shot task that has already run (or is running) cannot be edited.`,
  parameters: z.object({
    id: z.string().describe("The task id to edit"),
    schedule: CronScheduleParam.optional().describe("New schedule (omit to keep the current one)"),
    prompt: z.string().min(1).optional().describe("New deferred prompt (omit to keep the current one)"),
  }),
  async execute(params): Promise<{ title: string; output: string; metadata: { jobId?: string; code?: string } }> {
    const job = await CronStore.get(params.id)
    if (!job) {
      return { title: "Task not found", output: `No scheduled task with id "${params.id}".`, metadata: { code: "SCHED_TASK_NOT_FOUND" } }
    }
    if (!params.schedule && !params.prompt) {
      return { title: "Nothing to update", output: "Provide a new schedule and/or prompt.", metadata: { code: "SCHED_UPDATE_EMPTY" } }
    }
    // One-shot that already fired (or was settled) cannot be edited.
    if (job.schedule.kind === "at" && (job.state.lastRunAtMs !== undefined || !job.enabled)) {
      return { title: "Task already fired", output: `Task "${job.name}" has already run; it cannot be edited.`, metadata: { code: "SCHED_EDIT_AFTER_FIRE" } }
    }

    const patch: Parameters<typeof CronStore.update>[1] = {}
    if (params.schedule) {
      patch.schedule = params.schedule
      patch.state = { nextRunAtMs: Schedule.computeNextRunAtMs(params.schedule, Date.now()) }
    }
    if (params.prompt) {
      if (job.payload.kind !== "agentTurn") {
        return { title: "Cannot edit prompt", output: "This task has no agent prompt to edit.", metadata: { code: "SCHED_UPDATE_EMPTY" } }
      }
      patch.payload = { ...job.payload, message: params.prompt }
    }
    const updated = await CronStore.update(params.id, patch)
    const nextRunStr = updated?.state.nextRunAtMs ? new Date(updated.state.nextRunAtMs).toLocaleString() : "unchanged"

    return {
      title: `Updated task "${job.name}"`,
      output: [
        `Scheduled task updated.`,
        params.schedule ? `- **Schedule**: ${formatSchedule(params.schedule)}` : null,
        params.schedule ? `- **Next run**: ${nextRunStr}` : null,
        params.prompt ? `- **Prompt**: ${params.prompt.slice(0, 200)}${params.prompt.length > 200 ? "..." : ""}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { jobId: job.id },
    }
  },
})

// ── CronCancel ──────────────────────────────────────────────────────

export const CronCancelTool = Tool.define("cron_cancel", {
  description: `Cancel a scheduled task by id — removes its schedule and settles its subsession without firing. Use cron_status/cron_list to find the id. This is the same effect as cron_delete but also releases the dormant task subsession.`,
  parameters: z.object({
    id: z.string().describe("The task id to cancel"),
  }),
  async execute(
    params,
  ): Promise<{ title: string; output: string; metadata: { found: boolean; name?: string; code?: string } }> {
    const job = await CronStore.get(params.id)
    if (!job) {
      return { title: "Task not found", output: `No scheduled task with id "${params.id}".`, metadata: { found: false, code: "SCHED_TASK_NOT_FOUND" } }
    }
    await CronStore.remove(params.id)
    await RunLog.removeForJob(params.id)
    // harness/scheduled-subsession: settle the dormant subsession so it is no longer marked scheduled.
    if (job.dormantSessionID) await CronSession.release(job.dormantSessionID)
    return {
      title: `Cancelled task "${job.name}"`,
      output: `Scheduled task "${job.name}" (${params.id}) cancelled; it will not fire.`,
      metadata: { found: true, name: job.name },
    }
  },
})

// ── CronStatus ──────────────────────────────────────────────────────

export const CronStatusTool = Tool.define("cron_status", {
  description: `Report the status of scheduled task(s): schedule, next fire time, last run, and the dormant task subsession id. Pass an id for one task, or omit to summarize all. Use before editing/cancelling a task.`,
  parameters: z.object({
    id: z.string().optional().describe("A specific task id; omit to summarize all tasks"),
  }),
  async execute(params) {
    const jobs = params.id ? [await CronStore.get(params.id)].filter(Boolean) : await CronStore.list()
    if (jobs.length === 0) {
      return {
        title: params.id ? "Task not found" : "No scheduled tasks",
        output: params.id ? `No scheduled task with id "${params.id}".` : "No scheduled tasks exist.",
        metadata: { count: 0 },
      }
    }
    const lines = (jobs as NonNullable<(typeof jobs)[number]>[]).map((job) => {
      const status = !job.enabled
        ? job.schedule.kind === "at"
          ? "settled"
          : "disabled"
        : (job.state.lastRunStatus ?? "scheduled")
      const nextRun = job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString() : "—"
      const lastRun = job.state.lastRunAtMs ? new Date(job.state.lastRunAtMs).toLocaleString() : "never"
      return [
        `### ${job.name} (${status})`,
        `- **ID**: ${job.id}`,
        `- **Schedule**: ${formatSchedule(job.schedule)}`,
        `- **Next run**: ${nextRun}`,
        `- **Last run**: ${lastRun}`,
        job.dormantSessionID ? `- **Task subsession**: ${job.dormantSessionID}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    })
    return { title: `${jobs.length} task(s)`, output: lines.join("\n\n"), metadata: { count: jobs.length } }
  },
})

// ── Helpers ─────────────────────────────────────────────────────────

function formatSchedule(schedule: z.infer<typeof CronScheduleParam> | { kind: "at"; at: string }): string {
  if (schedule.kind === "cron") return `cron \`${schedule.expr}\`${schedule.tz ? ` (${schedule.tz})` : ""}`
  if (schedule.kind === "every") return `every ${formatDuration(schedule.everyMs)}`
  if (schedule.kind === "at") return `once at ${(schedule as { at: string }).at}`
  return "unknown"
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}
