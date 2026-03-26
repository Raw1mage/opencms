import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import { Instance } from "../../project/instance"
import { CronStore } from "../../cron/store"
import { RunLog } from "../../cron/run-log"
import { Heartbeat } from "../../cron/heartbeat"
import { TASKS_VIRTUAL_DIR } from "../../cron/virtual-project"
import { CronScheduleSchema, CronPayloadSchema, CronDeliverySchema, CronJobSchema, CronRunLogEntrySchema } from "../../cron/types"
import { errors } from "../error"
import { Log } from "../../util/log"

const log = Log.create({ service: "cron-routes" })

const CronJobCreateBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  schedule: CronScheduleSchema,
  payload: CronPayloadSchema,
  delivery: CronDeliverySchema.optional(),
  sessionTarget: z.enum(["main", "isolated"]).default("isolated"),
  wakeMode: z.enum(["next-heartbeat", "now"]).default("now"),
})

const CronJobPatchBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: CronScheduleSchema.optional(),
  payload: CronPayloadSchema.optional(),
  delivery: CronDeliverySchema.optional(),
  sessionTarget: z.enum(["main", "isolated"]).optional(),
  wakeMode: z.enum(["next-heartbeat", "now"]).optional(),
})

export const CronRoutes = lazy(() =>
  new Hono()
    .get(
      "/jobs",
      describeRoute({
        summary: "List all cron jobs",
        operationId: "cron.jobs.list",
        responses: {
          200: {
            description: "Array of cron jobs",
            content: { "application/json": { schema: resolver(z.array(CronJobSchema)) } },
          },
        },
      }),
      async (c) => {
        const jobs = await CronStore.list()
        return c.json(jobs)
      },
    )
    .get(
      "/jobs/:id",
      describeRoute({
        summary: "Get a cron job by ID",
        operationId: "cron.jobs.get",
        responses: {
          200: {
            description: "Cron job",
            content: { "application/json": { schema: resolver(CronJobSchema) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const { id } = c.req.valid("param")
        const job = await CronStore.get(id)
        if (!job) return c.json({ error: "Job not found" }, 404)
        return c.json(job)
      },
    )
    .post(
      "/jobs",
      describeRoute({
        summary: "Create a cron job",
        operationId: "cron.jobs.create",
        responses: {
          201: {
            description: "Created cron job",
            content: { "application/json": { schema: resolver(CronJobSchema) } },
          },
          ...errors(400),
        },
      }),
      validator("json", CronJobCreateBody),
      async (c) => {
        const body = c.req.valid("json")
        const job = await CronStore.create({
          name: body.name,
          description: body.description,
          enabled: body.enabled,
          schedule: body.schedule,
          payload: body.payload,
          delivery: body.delivery,
          sessionTarget: body.sessionTarget,
          wakeMode: body.wakeMode,
        })
        log.info("job created via REST", { id: job.id, name: job.name })
        return c.json(job, 201)
      },
    )
    .patch(
      "/jobs/:id",
      describeRoute({
        summary: "Update a cron job",
        operationId: "cron.jobs.update",
        responses: {
          200: {
            description: "Updated cron job",
            content: { "application/json": { schema: resolver(CronJobSchema) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", CronJobPatchBody),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const job = await CronStore.update(id, patch)
        if (!job) return c.json({ error: "Job not found" }, 404)
        log.info("job updated via REST", { id })
        return c.json(job)
      },
    )
    .delete(
      "/jobs/:id",
      describeRoute({
        summary: "Delete a cron job",
        operationId: "cron.jobs.delete",
        responses: {
          200: { description: "Job deleted" },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const { id } = c.req.valid("param")
        const removed = await CronStore.remove(id)
        if (!removed) return c.json({ error: "Job not found" }, 404)
        log.info("job deleted via REST", { id })
        return c.json({ ok: true })
      },
    )
    .get(
      "/jobs/:id/runs",
      describeRoute({
        summary: "Get run history for a cron job",
        operationId: "cron.jobs.runs",
        responses: {
          200: {
            description: "Array of run log entries",
            content: { "application/json": { schema: resolver(z.array(CronRunLogEntrySchema)) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const { id } = c.req.valid("param")
        const job = await CronStore.get(id)
        if (!job) return c.json({ error: "Job not found" }, 404)
        const limitStr = c.req.query("limit")
        const limit = limitStr ? parseInt(limitStr, 10) : 20
        const runs = await RunLog.read(id, limit)
        return c.json(runs)
      },
    )
    .post(
      "/jobs/:id/run",
      describeRoute({
        summary: "Trigger immediate execution of a cron job",
        operationId: "cron.jobs.trigger",
        responses: {
          200: { description: "Job triggered" },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const { id } = c.req.valid("param")
        const job = await CronStore.get(id)
        if (!job) return c.json({ error: "Job not found" }, 404)

        log.info("manual trigger via REST", { id, name: job.name })

        // Trigger by evaluating the job immediately via heartbeat
        // Wrap in Instance.provide() so sessions are scoped to the virtual tasks project
        try {
          await Instance.provide({
            directory: TASKS_VIRTUAL_DIR,
            fn: () => Heartbeat.tick(),
          })
        } catch (e) {
          log.error("manual trigger failed", { id, error: e })
        }

        return c.json({ ok: true, jobId: id })
      },
    )
    .get(
      "/project",
      describeRoute({
        summary: "Get the virtual tasks project directory",
        operationId: "cron.project",
        responses: {
          200: {
            description: "Virtual tasks project directory path",
            content: { "application/json": { schema: resolver(z.object({ directory: z.string() })) } },
          },
        },
      }),
      async (c) => {
        return c.json({ directory: TASKS_VIRTUAL_DIR })
      },
    ),
)
