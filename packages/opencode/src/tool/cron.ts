import z from "zod"
import { Tool } from "./tool"
import { CronStore } from "../cron/store"
import { RunLog } from "../cron/run-log"
import { Schedule } from "../cron/schedule"

const CronScheduleParam = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    expr: z.string().describe("5-field crontab expression (min hour dom mon dow). Example: '*/30 * * * *' for every 30 minutes"),
    tz: z.string().optional().describe("IANA timezone, e.g. 'Asia/Taipei'. Defaults to system timezone"),
  }),
  z.object({
    kind: z.literal("every"),
    everyMs: z.number().int().positive().describe("Interval in milliseconds"),
  }),
])

// ── CronCreate ──────────────────────────────────────────────────────

export const CronCreateTool = Tool.define("cron_create", {
  description: `Create a new scheduled task (cron job) that runs an AI prompt on a recurring schedule.

Use this tool when the user wants to automate a recurring AI workflow — e.g. "check my email every 30 minutes", "summarize news daily at 9 AM", "monitor stock alerts every hour".

The task will appear in the Scheduled Tasks UI and execute automatically according to the cron schedule. Each execution creates an isolated session with lightweight context.

After creating the task, tell the user they can manage it from the Tasks panel in the sidebar.`,
  parameters: z.object({
    name: z.string().min(1).describe("Short descriptive name for the task, e.g. 'Check stock alerts'"),
    description: z.string().optional().describe("Optional longer description of what this task does"),
    prompt: z.string().min(1).describe("The prompt that will be sent to the AI on each scheduled run. Be specific about what the AI should do and what tools/MCP servers it should use."),
    schedule: CronScheduleParam.describe("When to run. Prefer 'cron' kind with 5-field crontab expressions."),
    enabled: z.boolean().default(true).describe("Whether the task starts enabled immediately"),
  }),
  async execute(params) {
    const job = await CronStore.create({
      name: params.name,
      description: params.description,
      enabled: params.enabled,
      schedule: params.schedule,
      payload: {
        kind: "agentTurn",
        message: params.prompt,
        lightContext: true,
      },
      sessionTarget: "isolated",
      wakeMode: "now",
    })

    const nextRun = Schedule.computeNextRunAtMs(params.schedule, Date.now())
    const nextRunStr = nextRun ? new Date(nextRun).toLocaleString() : "unknown"

    return {
      title: `Created task "${params.name}"`,
      output: [
        `Scheduled task created successfully.`,
        ``,
        `- **ID**: ${job.id}`,
        `- **Name**: ${job.name}`,
        params.description ? `- **Description**: ${params.description}` : null,
        `- **Schedule**: ${formatSchedule(params.schedule)}`,
        `- **Next run**: ${nextRunStr}`,
        `- **Enabled**: ${params.enabled ? "yes" : "no"}`,
        `- **Prompt**: ${params.prompt.slice(0, 200)}${params.prompt.length > 200 ? "..." : ""}`,
        ``,
        `The task is now visible in the Scheduled Tasks panel (sidebar checklist icon).`,
      ].filter(Boolean).join("\n"),
      metadata: { jobId: job.id },
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
      const status = !job.enabled ? "disabled" : job.state.lastRunStatus === "error" ? "error" : job.state.lastRunStatus === "ok" ? "ok" : "pending"
      const nextRun = job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString() : "—"
      const lastRun = job.state.lastRunAtMs ? new Date(job.state.lastRunAtMs).toLocaleString() : "never"
      const errors = job.state.consecutiveErrors ?? 0
      const prompt = job.payload.kind === "agentTurn" ? job.payload.message : job.payload.kind === "systemEvent" ? job.payload.text : ""

      return [
        `### ${job.name} (${status})`,
        `- **ID**: ${job.id}`,
        job.description ? `- **Description**: ${job.description}` : null,
        `- **Schedule**: ${formatSchedule(job.schedule)}`,
        `- **Next run**: ${nextRun}`,
        `- **Last run**: ${lastRun}`,
        errors > 0 ? `- **Consecutive errors**: ${errors}` : null,
        `- **Prompt**: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`,
      ].filter(Boolean).join("\n")
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
  async execute(params) {
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
