import { Hono } from "hono"
import path from "path"
import { stream } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { generateText } from "ai"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"
import { SessionPrompt } from "../../session/prompt"
import { SessionCompaction } from "../../session/compaction"
import { SessionRevert } from "../../session/revert"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SessionMonitor } from "@/session/monitor"
import { SkillLayerRegistry } from "@/session/skill-layer-registry"
import { getSessionMessageDiff, getSessionOwnedDirtyDiff } from "@/project/workspace"
import { Todo } from "../../session/todo"
import { extractChecklistItems } from "@/session/tasks-checklist"
import { Agent } from "../../agent/agent"
import { Snapshot } from "@/snapshot"
import { Log } from "../../util/log"
import { PermissionNext } from "@/permission/next"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { RequestUser } from "@/runtime/request-user"
import { UserDaemonManager } from "../user-daemon"
import { SessionCache } from "../session-cache"
import { debugCheckpoint } from "@/util/debug"
import {
  enqueueAutonomousContinue,
  getAutonomousWorkflowHealth,
  getPendingContinuationQueueInspection,
  mutatePendingContinuationQueue,
} from "@/session/workflow-runner"
import { KillSwitchService } from "../killswitch/service"
import { Provider } from "../../provider/provider"

const AutonomousWorkflowHealthSchema = z.object({
  state: z.enum(["idle", "running", "waiting_user", "blocked", "completed"]),
  stopReason: z.string().optional(),
  queue: z.object({
    hasPendingContinuation: z.boolean(),
    roundCount: z.number().optional(),
    reason: z.string().optional(),
    queuedAt: z.number().optional(),
  }),
  supervisor: z.object({
    leaseOwner: z.string().optional(),
    leaseExpiresAt: z.number().optional(),
    retryAt: z.number().optional(),
    consecutiveResumeFailures: z.number(),
    lastResumeCategory: z.string().optional(),
    lastResumeError: z.string().optional(),
  }),
  anomalies: z.object({
    recentCount: z.number(),
    latestEventType: z.string().optional(),
    latestAt: z.number().optional(),
    flags: z.array(z.string()),
    countsByType: z.record(z.string(), z.number()),
  }),
  summary: z.object({
    health: z.enum(["healthy", "queued", "paused", "degraded", "blocked", "completed"]),
    label: z.string(),
  }),
})

const PendingContinuationQueueInspectionSchema = z.object({
  hasPendingContinuation: z.boolean(),
  pending: z
    .object({
      sessionID: z.string(),
      messageID: z.string(),
      createdAt: z.number(),
      roundCount: z.number(),
      reason: z.enum(["todo_pending", "todo_in_progress"]),
      text: z.string(),
    })
    .optional(),
  status: z.enum(["idle", "busy", "retry"]),
  inFlight: z.boolean(),
  resumable: z.boolean(),
  blockedReasons: z.array(z.string()),
  health: AutonomousWorkflowHealthSchema,
})

const PendingContinuationQueueControlSchema = z.object({
  action: z.enum(["resume_once", "drop_pending"]),
  applied: z.boolean(),
  reason: z.enum(["resumed", "dropped", "no_pending_continuation", "not_resumable", "resume_dispatch_skipped"]),
  blockedReasons: z.array(z.string()).optional(),
  inspection: PendingContinuationQueueInspectionSchema,
})

const SkillLayerInfoSchema = z.object({
  name: z.string(),
  loadedAt: z.number(),
  lastUsedAt: z.number(),
  runtimeState: z.enum(["active", "idle", "sticky", "summarized", "unloaded"]),
  desiredState: z.enum(["full", "summary", "absent"]),
  pinned: z.boolean(),
  lastReason: z.string(),
})

const SkillLayerActionSchema = z.object({
  action: z.enum(["pin", "unpin", "promote", "demote", "unload"]),
})

const SkillLayerActionResponseSchema = z.object({
  ok: z.boolean(),
  entries: SkillLayerInfoSchema.array(),
})

const log = Log.create({ service: "server" })
const SESSION_ROUTE_DEBUG_ENABLED = false

function sessionRouteDebug(event: string, data: Record<string, unknown>) {
  // Kept for future RCA; disabled during normal operation.
  if (!SESSION_ROUTE_DEBUG_ENABLED) return
  debugCheckpoint("session.route", event, data)
}

export const SessionRoutes = lazy(() =>
  new Hono()
    .use(async (c, next) => {
      // Daemon architecture: the web gateway requires an identified user so it
      // can route to the correct per-user daemon.  Without a username it would
      // fall back to the web-service user's own (stale) storage.
      // Skip this guard inside per-user daemons — they already serve a single user.
      const isDaemonProcess = process.env.OPENCODE_USER_DAEMON_MODE === "1"
      if (!isDaemonProcess && UserDaemonManager.enabled() && !RequestUser.username()) {
        return c.json(
          {
            code: "USER_IDENTITY_REQUIRED",
            message: "Session routes require an authenticated user when per-user daemon routing is enabled",
          },
          401,
        )
      }
      return next()
    })
    .get(
      "/",
      describeRoute({
        summary: "List sessions",
        description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
        operationId: "session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionListEnabled()) {
          const response = await UserDaemonManager.callSessionList<Session.Info[]>(username, query)
          if (response.ok && Array.isArray(response.data)) {
            return c.json(response.data)
          }
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.list payload is not an array" : response.error.message,
            },
            503,
          )
        }
        const sessions: Session.Info[] = []
        for await (const session of Session.listGlobal({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          search: query.search,
          limit: query.limit,
        })) {
          sessions.push(session)
        }
        return c.json(sessions)
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get session status",
        description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
        operationId: "session.status",
        responses: {
          200: {
            description: "Get session status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), SessionStatus.Info)),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const username = RequestUser.username()
        log.debug("session.status request", { username: username ?? "local" })
        sessionRouteDebug("session.status request", { username: username ?? "local" })
        if (username && UserDaemonManager.routeSessionStatusEnabled()) {
          const response =
            await UserDaemonManager.callSessionStatus<Record<string, z.infer<typeof SessionStatus.Info>>>(username)
          if (response.ok && response.data && typeof response.data === "object") {
            sessionRouteDebug("session.status response", {
              username,
              count: Object.keys(response.data).length,
              active: Object.entries(response.data)
                .filter(([, value]) => value?.type && value.type !== "idle")
                .map(([id, value]) => ({ id, type: value.type })),
            })
            log.debug("session.status response", {
              username,
              count: Object.keys(response.data).length,
              active: Object.entries(response.data)
                .filter(([, value]) => value?.type && value.type !== "idle")
                .map(([id, value]) => ({ id, type: value.type })),
            })
            return c.json(response.data)
          }
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.status payload is not an object" : response.error.message,
            },
            503,
          )
        }
        const result = SessionStatus.list()
        sessionRouteDebug("session.status response", {
          username: "local",
          count: Object.keys(result).length,
          active: Object.entries(result)
            .filter(([, value]) => value?.type && value.type !== "idle")
            .map(([id, value]) => ({ id, type: value.type })),
        })
        log.debug("session.status response", {
          username: "local",
          count: Object.keys(result).length,
          active: Object.entries(result)
            .filter(([, value]) => value?.type && value.type !== "idle")
            .map(([id, value]) => ({ id, type: value.type })),
        })
        return c.json(result)
      },
    )
    .get(
      "/top",
      describeRoute({
        summary: "Get session monitor snapshot",
        description: "Retrieve the latest top-like session monitor snapshot for active sessions.",
        operationId: "session.top",
        responses: {
          200: {
            description: "Session monitor snapshot",
            content: {
              "application/json": {
                schema: resolver(SessionMonitor.Info.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          sessionID: z.string().optional().meta({ description: "Restrict monitor snapshot to one session" }),
          includeDescendants: z.coerce
            .boolean()
            .optional()
            .meta({ description: "Include descendant sessions when sessionID is provided" }),
          maxMessages: z.coerce
            .number()
            .optional()
            .meta({ description: "Limit messages scanned per session for monitor snapshot" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionTopEnabled()) {
          const response = await UserDaemonManager.callSessionTop<z.infer<typeof SessionMonitor.Info>[]>(username, {
            sessionID: query.sessionID,
            includeDescendants: query.includeDescendants,
            maxMessages: query.maxMessages,
          })
          if (response.ok && Array.isArray(response.data)) {
            return c.json(response.data)
          }
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.top payload is not an array" : response.error.message,
            },
            503,
          )
        }
        const result = await SessionMonitor.snapshot({
          sessionID: query.sessionID,
          includeDescendants: query.includeDescendants,
          maxMessages: query.maxMessages,
        })
        return c.json(result)
      },
    )
    .get(
      "/:sessionID",
      describeRoute({
        summary: "Get session",
        description: "Retrieve detailed information about a specific OpenCode session.",
        tags: ["Session"],
        operationId: "session.get",
        responses: {
          200: {
            description: "Get session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const username = RequestUser.username()
        log.debug("session.get request", { sessionID, username: username ?? "local" })
        sessionRouteDebug("session.get request", {
          sessionID,
          username: username ?? "local",
        })
        if (username && UserDaemonManager.routeSessionReadEnabled()) {
          const response = await UserDaemonManager.callSessionGet<Session.Info>(username, sessionID)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.get payload is empty" : response.error.message,
            },
            503,
          )
        }
        log.info("SEARCH", { url: c.req.url })

        // Conditional GET short-circuit — if the client already has the
        // latest version we avoid the cache lookup, the loader, and JSON
        // serialization entirely. See specs/session-poll-cache/ R-2.
        const etag = SessionCache.currentEtag(sessionID)
        const ifNoneMatch = c.req.header("if-none-match")
        if (SessionCache.isEtagMatch(sessionID, ifNoneMatch)) {
          c.header("ETag", etag)
          return c.body(null, 304)
        }

        const { data: session } = await SessionCache.get(
          `session:${sessionID}`,
          sessionID,
          async () => {
            const data = await Session.get(sessionID)
            return { data, version: SessionCache.getVersion(sessionID) }
          },
        )
        sessionRouteDebug("session.get response", {
          sessionID,
          found: !!session,
          directory: session?.directory,
        })
        log.debug("session.get response", {
          sessionID,
          found: !!session,
          directory: session?.directory,
        })
        c.header("ETag", SessionCache.currentEtag(sessionID))
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/children",
      describeRoute({
        summary: "Get session children",
        tags: ["Session"],
        description: "Retrieve all child sessions that were forked from the specified parent session.",
        operationId: "session.children",
        responses: {
          200: {
            description: "List of children",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.children.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionReadEnabled()) {
          const response = await UserDaemonManager.callSessionChildren<Session.Info[]>(username, sessionID)
          if (response.ok) {
            const parsed = SkillLayerInfoSchema.array().safeParse(response.data)
            if (parsed.success) return c.json(parsed.data)
          }
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.children payload is not an array" : response.error.message,
            },
            503,
          )
        }
        const session = await Session.children(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/todo",
      describeRoute({
        summary: "Get session todos",
        description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
        operationId: "session.todo",
        responses: {
          200: {
            description: "Todo list",
            content: {
              "application/json": {
                schema: resolver(Todo.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionReadEnabled()) {
          const response = await UserDaemonManager.callSessionTodo<z.infer<typeof Todo.Info>[]>(username, sessionID)
          if (response.ok) {
            const parsed = SkillLayerInfoSchema.array().safeParse(response.data)
            if (parsed.success) return c.json(parsed.data)
          }
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.todo payload is not an array" : response.error.message,
            },
            503,
          )
        }
        // Mission-based tasks.md seeding removed 2026-04-18 along with the
        // mission schema. Todo list is now exclusively AI-maintained via
        // TodoWrite (plan-builder skill owns plan reconciliation).
        const currentTodos = await Todo.get(sessionID)
        return c.json(currentTodos)
      },
    )
    .get(
      "/:sessionID/skill-layer",
      describeRoute({
        summary: "Get session skill layers",
        description: "Retrieve managed skill-layer states for one session.",
        operationId: "session.skillLayer.list",
        responses: {
          200: {
            description: "Skill layer list",
            content: {
              "application/json": {
                schema: resolver(SkillLayerInfoSchema.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionReadEnabled()) {
          const response = await UserDaemonManager.callSessionSkillLayerList<z.infer<typeof SkillLayerInfoSchema>[]>(
            username,
            sessionID,
          )
          if (response.ok) {
            const parsed = SkillLayerInfoSchema.array().safeParse(response.data)
            if (parsed.success) return c.json(parsed.data)
          }
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok
                ? "daemon session.skillLayer.list payload failed schema validation"
                : response.error.message,
            },
            503,
          )
        }
        await Session.get(sessionID)
        return c.json(SkillLayerRegistry.list(sessionID))
      },
    )
    .post(
      "/:sessionID/skill-layer/:name/action",
      describeRoute({
        summary: "Mutate session skill layer state",
        description: "Apply operator action to one managed skill layer in the session scope.",
        operationId: "session.skillLayer.action",
        responses: {
          200: {
            description: "Mutation result",
            content: {
              "application/json": {
                schema: resolver(SkillLayerActionResponseSchema),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          name: z.string().meta({ description: "Skill name" }),
        }),
      ),
      validator("json", SkillLayerActionSchema),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionSkillLayerAction<{
            ok: boolean
            entries: z.infer<typeof SkillLayerInfoSchema>[]
          }>(username, params.sessionID, params.name, body)
          if (response.ok) {
            const parsed = SkillLayerActionResponseSchema.safeParse(response.data)
            if (parsed.success) return c.json(parsed.data)
          }
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok
                ? "daemon session.skillLayer.action payload failed schema validation"
                : response.error.message,
            },
            503,
          )
        }

        await Session.get(params.sessionID)
        if (body.action === "pin") {
          SkillLayerRegistry.pin(params.sessionID, params.name)
        } else if (body.action === "unpin") {
          SkillLayerRegistry.unpin(params.sessionID, params.name)
        } else if (body.action === "promote") {
          SkillLayerRegistry.setDesiredState(params.sessionID, params.name, {
            desiredState: "full",
            lastReason: "operator_promote_full",
          })
        } else if (body.action === "demote") {
          SkillLayerRegistry.setDesiredState(params.sessionID, params.name, {
            desiredState: "summary",
            lastReason: "operator_demote_summary",
          })
        } else {
          SkillLayerRegistry.setDesiredState(params.sessionID, params.name, {
            desiredState: "absent",
            lastReason: "operator_unload_absent",
          })
        }

        return c.json({
          ok: true,
          entries: SkillLayerRegistry.list(params.sessionID),
        })
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create session",
        description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
        operationId: "session.create",
        responses: {
          ...errors(400),
          200: {
            description: "Successfully created session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator("json", Session.create.schema.optional()),
      async (c) => {
        const body = c.req.valid("json") ?? {}
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionCreate<Session.Info>(username, body)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.create payload is empty" : response.error.message,
            },
            503,
          )
        }
        const session = await Session.create(body)
        return c.json(session)
      },
    )
    .delete(
      "/:sessionID",
      describeRoute({
        summary: "Delete session",
        description: "Delete a session and permanently remove all associated data, including messages and history.",
        operationId: "session.delete",
        responses: {
          200: {
            description: "Successfully deleted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.remove.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionDelete<boolean>(username, sessionID)
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        Session.remove(sessionID).catch((err) => {
          log.error("REMOVE_FAILED", { sessionID, error: err })
        })
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID",
      describeRoute({
        summary: "Update session",
        description: "Update properties of an existing session, such as title or other metadata.",
        operationId: "session.update",
        responses: {
          200: {
            description: "Successfully updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      validator(
        "json",
        z.object({
          title: z.string().optional(),
          execution: z
            .object({
              providerId: z.string(),
              modelID: z.string(),
              accountId: z.string().optional(),
            })
            .optional(),
          time: z
            .object({
              archived: z.number().optional(),
            })
            .optional(),
          workflow: z
            .object({
              autonomous: Session.AutonomousPolicy.partial().optional(),
              state: Session.WorkflowState.optional(),
              stopReason: z.string().nullable().optional(),
            })
            .optional(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const updates = c.req.valid("json")

        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionUpdate<Session.Info>(username, sessionID, updates)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.update payload is empty" : response.error.message,
            },
            503,
          )
        }
        const updatedSession = await Session.update(
          sessionID,
          (session) => {
            if (updates.title !== undefined) {
              session.title = updates.title
            }
            if (updates.execution) {
              session.execution = Session.nextExecutionIdentity({
                current: session.execution,
                model: updates.execution,
              })
            }
            if (updates.time?.archived !== undefined) session.time.archived = updates.time.archived
            if (updates.workflow) {
              const current = session.workflow ?? Session.defaultWorkflow(session.time.updated)
              session.workflow = {
                ...current,
                autonomous: updates.workflow.autonomous
                  ? Session.mergeAutonomousPolicy(current.autonomous, updates.workflow.autonomous)
                  : current.autonomous,
                state: updates.workflow.state ?? current.state,
                stopReason:
                  updates.workflow.stopReason === undefined
                    ? current.stopReason
                    : (updates.workflow.stopReason ?? undefined),
                updatedAt: Date.now(),
              }
            }
          },
          { touch: false },
        )

        // Propagate model change to active child worker (if any)
        if (updates.execution) {
          try {
            const { sendModelUpdateToActiveChild } = await import("@/tool/task")
            await sendModelUpdateToActiveChild(sessionID, updates.execution)
          } catch {
            // No active child or propagation failed — non-blocking
          }
        }

        return c.json(updatedSession)
      },
    )
    .post(
      "/:sessionID/autonomous",
      describeRoute({
        summary: "Toggle autonomous session mode",
        description:
          "Enable or disable autonomous continuation for a session, and optionally enqueue an immediate continue turn.",
        operationId: "session.autonomous",
        responses: {
          200: {
            description: "Updated autonomous workflow state",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          enabled: z.boolean(),
          enqueue: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")

        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionAutonomous<Session.Info>(username, sessionID, body)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.autonomous payload is empty" : response.error.message,
            },
            503,
          )
        }

        // Autonomous is always-on — ignore body.enabled, always ensure enabled: true
        const session = await Session.get(sessionID)
        const workflow = session.workflow ?? Session.defaultWorkflow(session.time.updated)
        const updatedSession = await Session.update(
          sessionID,
          (draft) => {
            const current = draft.workflow ?? Session.defaultWorkflow(draft.time.updated)
            draft.workflow = {
              ...current,
              autonomous: { ...current.autonomous, enabled: true },
              state: current.state === "completed" ? "idle" : current.state,
              stopReason: undefined,
              updatedAt: Date.now(),
            }
          },
          { touch: false },
        )

        if (body.enqueue !== false) {
          let lastUser: MessageV2.User | undefined
          for await (const message of MessageV2.stream(sessionID)) {
            if (message.info.role === "user") lastUser = message.info as MessageV2.User
          }
          if (!lastUser) {
            throw new Error(`no user message found for autonomous continuation: ${sessionID}`)
          }
          if (SessionStatus.get(sessionID).type === "idle") {
            await enqueueAutonomousContinue({
              sessionID,
              user: lastUser,
              roundCount: workflow.lastRunAt ? 1 : 0,
            })
          }
        }

        return c.json(updatedSession)
      },
    )
    .get(
      "/:sessionID/autonomous/health",
      describeRoute({
        summary: "Get autonomous workflow health",
        description:
          "Return a converged health snapshot for autonomous execution, including queue state, supervisor retry state, and recent anomaly evidence.",
        operationId: "session.autonomous.health",
        responses: {
          200: {
            description: "Autonomous workflow health snapshot",
            content: {
              "application/json": {
                schema: resolver(AutonomousWorkflowHealthSchema),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionReadEnabled()) {
          const response = await UserDaemonManager.callSessionAutonomousHealth<
            z.infer<typeof AutonomousWorkflowHealthSchema>
          >(username, sessionID)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.autonomous.health payload is empty" : response.error.message,
            },
            503,
          )
        }

        // Existence guard piggybacks on the session cache so every polling hit
        // to /autonomous/health doesn't trigger a fresh Session.get disk read.
        await SessionCache.get(`session:${sessionID}`, sessionID, async () => {
          const data = await Session.get(sessionID)
          return { data, version: SessionCache.getVersion(sessionID) }
        })
        const health = await getAutonomousWorkflowHealth(sessionID)
        return c.json(health)
      },
    )
    .get(
      "/:sessionID/autonomous/queue",
      describeRoute({
        summary: "Inspect pending autonomous continuation queue state",
        description:
          "Return queue inspection for one session, including pending continuation payload, resumable/blocked classification, and block reasons.",
        operationId: "session.autonomous.queue",
        responses: {
          200: {
            description: "Pending continuation queue inspection",
            content: {
              "application/json": {
                schema: resolver(PendingContinuationQueueInspectionSchema),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionReadEnabled()) {
          const response = await UserDaemonManager.callSessionAutonomousQueue<
            z.infer<typeof PendingContinuationQueueInspectionSchema>
          >(username, sessionID)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.autonomous.queue payload is empty" : response.error.message,
            },
            503,
          )
        }

        await Session.get(sessionID)
        const inspection = await getPendingContinuationQueueInspection(sessionID)
        return c.json(inspection)
      },
    )
    .post(
      "/:sessionID/autonomous/queue",
      describeRoute({
        summary: "Control pending autonomous continuation queue",
        description:
          "Apply operator control actions for one session pending queue (resume once or drop pending item), returning post-action inspection state.",
        operationId: "session.autonomous.queue.control",
        responses: {
          200: {
            description: "Pending continuation queue control result",
            content: {
              "application/json": {
                schema: resolver(PendingContinuationQueueControlSchema),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          action: z.enum(["resume_once", "drop_pending"]),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionAutonomousQueueControl<
            z.infer<typeof PendingContinuationQueueControlSchema>
          >(username, sessionID, body)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok
                ? "daemon session.autonomous.queue.control payload is empty"
                : response.error.message,
            },
            503,
          )
        }

        await Session.get(sessionID)
        const result = await mutatePendingContinuationQueue({
          sessionID,
          action: body.action,
        })
        return c.json(result)
      },
    )
    .post(
      "/:sessionID/init",
      describeRoute({
        summary: "Initialize session",
        description:
          "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
        operationId: "session.init",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", Session.initialize.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionInit<boolean>(username, sessionID, body)
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        await Session.initialize({ ...body, sessionID })
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/fork",
      describeRoute({
        summary: "Fork session",
        description: "Create a new session by forking an existing session at a specific message point.",
        operationId: "session.fork",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.fork.schema.shape.sessionID,
        }),
      ),
      validator("json", Session.fork.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionFork<Session.Info>(username, sessionID, body)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.fork payload is empty" : response.error.message,
            },
            503,
          )
        }
        const result = await Session.fork({ ...body, sessionID })
        return c.json(result)
      },
    )
    .post(
      "/:sessionID/abort",
      describeRoute({
        summary: "Abort session",
        description: "Abort an active session and stop any ongoing AI processing or command execution.",
        operationId: "session.abort",
        responses: {
          200: {
            description: "Aborted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        // Cancel immediately — don't block on daemon call
        SessionPrompt.cancel(sessionID)
        // Also terminate any active child worker for this session
        const { terminateActiveChild } = await import("@/tool/task")
        terminateActiveChild(sessionID).catch(() => {})
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          // Fire-and-forget: notify daemon but don't wait
          UserDaemonManager.callSessionAbort<boolean>(username, sessionID).catch(() => {})
        }
        return c.json(true)
      },
    )
    .post(
      "/abort-all",
      describeRoute({
        summary: "Abort all sessions",
        description:
          "Emergency stop: abort every busy session and activate the kill-switch to block new work. No MFA required — designed for double-click emergency use.",
        operationId: "session.abortAll",
        responses: {
          200: {
            description: "All sessions aborted",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    aborted: z.number(),
                    killSwitchActive: z.boolean(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        // 1. Terminate all active worker processes FIRST — they run in separate
        //    processes and are invisible to SessionStatus.list().
        const { terminateAllActiveWorkers, terminateActiveChild } = await import("@/tool/task")
        const workersCanceled = terminateAllActiveWorkers()

        // 2. Cancel all sessions tracked in the main process.
        //    Also terminate their active child workers — the orchestrator
        //    session may be "busy" waiting for a tool call, but its child
        //    worker might not have been caught by terminateAllActiveWorkers
        //    if worker.current was already cleared.
        const busyIDs = await KillSwitchService.listBusySessionIDs()
        for (const id of busyIDs) {
          SessionPrompt.cancel(id)
          terminateActiveChild(id).catch(() => {})
        }

        const totalAborted = busyIDs.length + workersCanceled
        const requestID = await KillSwitchService.idempotentRequestID("emergency_stop", "double-click stop", 5000)
        await KillSwitchService.writeAudit({
          requestID,
          initiator: "emergency_stop",
          action: "emergency_abort_all",
          result: "ok",
          meta: { aborted: totalAborted, sessions: busyIDs.length, workers: workersCanceled },
        })
        // Emergency stop is a one-shot action: audit the kill, then clear state
        // immediately so the UI doesn't show a stale kill-switch banner.
        await KillSwitchService.clearState()
        return c.json({ aborted: totalAborted, killSwitchActive: false })
      },
    )
    .post(
      "/:sessionID/share",
      describeRoute({
        summary: "Share session",
        description: "Create a shareable link for a session, allowing others to view the conversation.",
        operationId: "session.share",
        responses: {
          200: {
            description: "Successfully shared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionShare<Session.Info>(username, sessionID)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.share payload is empty" : response.error.message,
            },
            503,
          )
        }
        await Session.share(sessionID)
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/diff",
      describeRoute({
        summary: "Get session diff",
        description:
          "Get the authoritative session-owned dirty diff for the current workspace, or the summarized diff for a specific user message when messageID is provided.",
        operationId: "session.diff",
        responses: {
          200: {
            description: "Successfully retrieved diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionSummary.diff.schema.shape.sessionID,
        }),
      ),
      validator(
        "query",
        z.object({
          messageID: SessionSummary.diff.schema.shape.messageID,
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const params = c.req.valid("param")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionReadEnabled()) {
          const response = await UserDaemonManager.callSessionDiff<Snapshot.FileDiff[]>(
            username,
            params.sessionID,
            query.messageID,
          )
          if (response.ok && Array.isArray(response.data)) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.diff payload is not an array" : response.error.message,
            },
            503,
          )
        }
        const result = query.messageID
          ? await getSessionMessageDiff({ sessionID: params.sessionID, messageID: query.messageID })
          : await getSessionOwnedDirtyDiff({ sessionID: params.sessionID })
        return c.json(result)
      },
    )
    .delete(
      "/:sessionID/share",
      describeRoute({
        summary: "Unshare session",
        description: "Remove the shareable link for a session, making it private again.",
        operationId: "session.unshare",
        responses: {
          200: {
            description: "Successfully unshared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.unshare.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionUnshare<Session.Info>(username, sessionID)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.unshare payload is empty" : response.error.message,
            },
            503,
          )
        }
        await Session.unshare(sessionID)
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/summarize",
      describeRoute({
        summary: "Summarize session",
        description: "Generate a concise summary of the session using AI compaction to preserve key information.",
        operationId: "session.summarize",
        responses: {
          200: {
            description: "Summarized session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          providerId: z.string(),
          modelID: z.string(),
          auto: z.boolean().optional().default(false),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionSummarize<boolean>(username, sessionID, body)
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        const session = await Session.get(sessionID)
        await SessionRevert.cleanup(session)
        const msgs = await Session.messages({ sessionID })
        let currentAgent = await Agent.defaultAgent()
        for (let i = msgs.length - 1; i >= 0; i--) {
          const info = msgs[i].info
          if (info.role === "user") {
            currentAgent = info.agent || (await Agent.defaultAgent())
            break
          }
        }
        await SessionCompaction.create({
          sessionID,
          agent: currentAgent,
          model: {
            providerId: body.providerId,
            modelID: body.modelID,
          },
          auto: body.auto,
        })
        await SessionPrompt.loop(sessionID)
        return c.json(true)
      },
    )
    .get(
      "/:sessionID/message",
      describeRoute({
        summary: "Get session messages",
        description: "Retrieve all messages in a session, including user prompts and AI responses.",
        operationId: "session.messages",
        responses: {
          200: {
            description: "List of messages",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator(
        "query",
        z.object({
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessionID = c.req.valid("param").sessionID
        const username = RequestUser.username()
        log.debug("session.messages request", {
          sessionID,
          limit: query.limit,
          username: username ?? "local",
        })
        sessionRouteDebug("session.messages request", {
          sessionID,
          limit: query.limit,
          username: username ?? "local",
        })
        if (username && UserDaemonManager.routeSessionReadEnabled()) {
          const response = await UserDaemonManager.callSessionMessages<MessageV2.WithParts[]>(
            username,
            sessionID,
            query.limit,
          )
          if (response.ok && Array.isArray(response.data)) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.messages payload is not an array" : response.error.message,
            },
            503,
          )
        }
        // Conditional GET short-circuit for message listing. See R-2.
        const etag = SessionCache.currentEtag(sessionID)
        const ifNoneMatch = c.req.header("if-none-match")
        if (SessionCache.isEtagMatch(sessionID, ifNoneMatch)) {
          c.header("ETag", etag)
          return c.body(null, 304)
        }

        const cacheKey = `messages:${sessionID}:${query.limit ?? "all"}`
        const { data: messages } = await SessionCache.get(
          cacheKey,
          sessionID,
          async () => {
            const data = await Session.messages({ sessionID, limit: query.limit })
            return { data, version: SessionCache.getVersion(sessionID) }
          },
        )
        sessionRouteDebug("session.messages response", {
          sessionID,
          count: messages.length,
          limit: query.limit,
        })
        log.debug("session.messages response", {
          sessionID,
          count: messages.length,
          limit: query.limit,
        })
        c.header("ETag", SessionCache.currentEtag(sessionID))
        return c.json(messages)
      },
    )
    .get(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Get message",
        description: "Retrieve a specific message from a session by its message ID.",
        operationId: "session.message",
        responses: {
          200: {
            description: "Message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Info,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          messageID: z.string().meta({ description: "Message ID" }),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionReadEnabled()) {
          const response = await UserDaemonManager.callSessionMessageGet<{
            info: MessageV2.Info
            parts: MessageV2.Part[]
          }>(username, params.sessionID, params.messageID)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.message.get payload is empty" : response.error.message,
            },
            503,
          )
        }
        const message = await MessageV2.get({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(message)
      },
    )
    .delete(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Delete message",
        description:
          "Permanently delete a specific message (and all of its parts) from a session. This does not revert any file changes that may have been made while processing the message.",
        operationId: "session.deleteMessage",
        responses: {
          200: {
            description: "Successfully deleted message",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          messageID: z.string().meta({ description: "Message ID" }),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionMessageDelete<boolean>(
            username,
            params.sessionID,
            params.messageID,
          )
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        SessionPrompt.assertNotBusy(params.sessionID)
        await Session.removeMessage({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(true)
      },
    )
    .delete(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Delete a part from a message",
        operationId: "part.delete",
        responses: {
          200: {
            description: "Successfully deleted part",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          messageID: z.string().meta({ description: "Message ID" }),
          partID: z.string().meta({ description: "Part ID" }),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionPartDelete<boolean>(
            username,
            params.sessionID,
            params.messageID,
            params.partID,
          )
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        await Session.removePart({
          sessionID: params.sessionID,
          messageID: params.messageID,
          partID: params.partID,
        })
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Update a part in a message",
        operationId: "part.update",
        responses: {
          200: {
            description: "Successfully updated part",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Part),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
          messageID: z.string().meta({ description: "Message ID" }),
          partID: z.string().meta({ description: "Part ID" }),
        }),
      ),
      validator("json", MessageV2.Part),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionPartUpdate<MessageV2.Part>(
            username,
            params.sessionID,
            params.messageID,
            params.partID,
            {
              ...body,
              id: params.partID,
              messageID: params.messageID,
              sessionID: params.sessionID,
            },
          )
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.part.update payload is empty" : response.error.message,
            },
            503,
          )
        }
        if (body.id !== params.partID || body.messageID !== params.messageID || body.sessionID !== params.sessionID) {
          throw new Error(
            `Part mismatch: body.id='${body.id}' vs partID='${params.partID}', body.messageID='${body.messageID}' vs messageID='${params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${params.sessionID}'`,
          )
        }
        const part = await Session.updatePart(body)
        return c.json(part)
      },
    )
    .post(
      "/:sessionID/message",
      describeRoute({
        summary: "Send message",
        description: "Create and send a new message to a session, streaming the AI response.",
        operationId: "session.prompt",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        const gate = await KillSwitchService.assertSchedulingAllowed()
        if (!gate.ok) {
          return c.json(
            {
              code: "KILL_SWITCH_ACTIVE",
              message: "Kill-switch is active; new task scheduling is paused",
              state: gate.state,
            },
            409,
          )
        }
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionPrompt<{
            info: MessageV2.Assistant
            parts: MessageV2.Part[]
          }>(username, sessionID, body)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.prompt payload is empty" : response.error.message,
            },
            503,
          )
        }
        c.status(200)
        c.header("Content-Type", "application/json")
        return stream(c, async (stream) => {
          const msg = await SessionPrompt.prompt({ ...body, sessionID })
          stream.write(JSON.stringify(msg))
        })
      },
    )
    .post(
      "/:sessionID/prompt_async",
      describeRoute({
        summary: "Send async message",
        description:
          "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
        operationId: "session.prompt_async",
        responses: {
          204: {
            description: "Prompt accepted",
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        const gate = await KillSwitchService.assertSchedulingAllowed()
        if (!gate.ok) {
          return c.json(
            {
              code: "KILL_SWITCH_ACTIVE",
              message: "Kill-switch is active; new task scheduling is paused",
              state: gate.state,
            },
            409,
          )
        }
        c.status(204)
        c.header("Content-Type", "application/json")
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionPromptAsync<boolean>(username, sessionID, body)
          if (response.ok) return stream(c, async () => {})
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        return stream(c, async () => {
          SessionPrompt.prompt({ ...body, sessionID })
        })
      },
    )
    .post(
      "/:sessionID/command",
      describeRoute({
        summary: "Send command",
        description: "Send a new command to a session for execution by the AI assistant.",
        operationId: "session.command",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionPrompt.CommandInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionCommand<MessageV2.Assistant>(username, sessionID, body)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.command payload is empty" : response.error.message,
            },
            503,
          )
        }
        const msg = await SessionPrompt.command({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/shell",
      describeRoute({
        summary: "Run shell command",
        description: "Execute a shell command within the session context and return the AI's response.",
        operationId: "session.shell",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Assistant),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      validator("json", SessionPrompt.ShellInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionShell<MessageV2.Assistant>(username, sessionID, body)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.shell payload is empty" : response.error.message,
            },
            503,
          )
        }
        const msg = await SessionPrompt.shell({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/revert",
      describeRoute({
        summary: "Revert message",
        description: "Revert a specific message in a session, undoing its effects and restoring the previous state.",
        operationId: "session.revert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      validator("json", SessionRevert.RevertInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("revert", c.req.valid("json"))
        const body = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionRevert<Session.Info>(username, sessionID, body)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.revert payload is empty" : response.error.message,
            },
            503,
          )
        }
        const session = await SessionRevert.revert({
          sessionID,
          ...body,
        })
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/unrevert",
      describeRoute({
        summary: "Restore reverted messages",
        description: "Restore all previously reverted messages in a session.",
        operationId: "session.unrevert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeSessionMutationEnabled()) {
          const response = await UserDaemonManager.callSessionUnrevert<Session.Info>(username, sessionID)
          if (response.ok && response.data) return c.json(response.data)
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon session.unrevert payload is empty" : response.error.message,
            },
            503,
          )
        }
        const session = await SessionRevert.unrevert({ sessionID })
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/permissions/:permissionID",
      describeRoute({
        summary: "Respond to permission",
        deprecated: true,
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.respond",
        responses: {
          200: {
            description: "Permission processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
          permissionID: z.string(),
        }),
      ),
      validator("json", z.object({ response: PermissionNext.Reply })),
      async (c) => {
        const params = c.req.valid("param")
        PermissionNext.reply({
          requestID: params.permissionID,
          reply: c.req.valid("json").response,
        })
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/transcribe",
      describeRoute({
        summary: "Transcribe audio",
        description:
          "Accept an audio recording and return transcribed text using an audio-capable model.",
        operationId: "session.transcribe",
        responses: {
          200: {
            description: "Transcription result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    text: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404, 500),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string().meta({ description: "Session ID" }),
        }),
      ),
      async (c) => {
        const log = Log.create({ service: "session.transcribe" })
        const { sessionID } = c.req.valid("param")

        // Parse multipart form data
        const formData = await c.req.formData().catch(() => null)
        if (!formData) {
          return c.json({ code: "INVALID_BODY", message: "Expected multipart form data with audio file" }, 400)
        }
        const audioFile = formData.get("audio")
        if (!audioFile || !(audioFile instanceof File)) {
          return c.json({ code: "MISSING_AUDIO", message: "Missing 'audio' field in form data" }, 400)
        }

        const mime = audioFile.type || "audio/webm"
        if (!mime.startsWith("audio/")) {
          return c.json({ code: "INVALID_MIME", message: `Expected audio/* MIME type, got ${mime}` }, 400)
        }

        // Resolve model from session or form hint
        const modelHint = formData.get("model") as string | null
        const providerHint = formData.get("provider") as string | null

        let model: Provider.Model | undefined
        try {
          if (providerHint && modelHint) {
            model = await Provider.getModel(providerHint, modelHint)
          } else {
            // Try to resolve from session's last used model
            const session = await Session.get(sessionID).catch(() => undefined)
            if (session?.modelID && session?.providerId) {
              model = await Provider.getModel(session.providerId, session.modelID).catch(() => undefined)
            }
          }

          // If resolved model doesn't support audio, find one that does
          if (model && !model.capabilities.input.audio) {
            log.info("session model lacks audio input, searching for audio-capable model", {
              sessionID,
              originalModel: `${model.providerId}/${model.id}`,
            })
            model = undefined
          }

          if (!model) {
            // Search all providers for an audio-capable model
            const providers = await Provider.list()
            for (const [, provider] of Object.entries(providers)) {
              for (const [, m] of Object.entries(provider.models)) {
                if (m.capabilities.input.audio) {
                  model = m
                  break
                }
              }
              if (model) break
            }
          }
        } catch (err) {
          log.error("failed to resolve model for transcription", { sessionID, error: err })
        }

        if (!model) {
          return c.json(
            {
              code: "NO_AUDIO_MODEL",
              message: "No audio-capable model available. Configure a provider with audio input support (e.g. Gemini).",
            },
            400,
          )
        }

        log.info("transcribing audio", {
          sessionID,
          model: `${model.providerId}/${model.id}`,
          mime,
          size: audioFile.size,
        })

        try {
          const language = await Provider.getLanguage(model)
          const audioBuffer = await audioFile.arrayBuffer()
          const audioData = new Uint8Array(audioBuffer)

          const result = await generateText({
            model: language,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "file",
                    data: audioData,
                    mimeType: mime,
                  },
                  {
                    type: "text",
                    text: "Transcribe this audio recording exactly as spoken. Output only the transcribed text, nothing else. Preserve the original language.",
                  },
                ],
              },
            ],
            maxRetries: 1,
          })

          const text = result.text?.trim() ?? ""
          log.info("transcription complete", { sessionID, textLength: text.length })
          return c.json({ text })
        } catch (err) {
          const message = err instanceof Error ? err.message : "Transcription failed"
          log.error("transcription failed", { sessionID, error: err })
          return c.json({ code: "TRANSCRIPTION_FAILED", message }, 500)
        }
      },
    ),
)
