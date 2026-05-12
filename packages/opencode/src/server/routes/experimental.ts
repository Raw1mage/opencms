import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { ToolRegistry } from "../../tool/registry"
import { Worktree } from "../../worktree"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import { MCP } from "../../mcp"
import { Session } from "../../session"
import { zodToJsonSchema } from "zod-to-json-schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { UserDaemonManager } from "../user-daemon"
import { File } from "../../file"
import { RequestUser } from "@/runtime/request-user"
import { git } from "@/util/git"
import { debugCheckpoint } from "@/util/debug"
import { Global } from "@/global"
import { Log } from "@/util/log"
import path from "path"

const log = Log.create({ service: "experimental" })

const EXPERIMENTAL_DEBUG_BEACON_ENABLED = process.env.OPENCODE_DEBUG_BEACON === "1"
const SCROLL_CAPTURE_FILE = path.join(Global.Path.log, "scroll-capture-latest.json")
const MAX_SCROLL_CAPTURE_HISTORY = 10

type ScrollCaptureRecord = {
  capturedAt: number
  requestUser: string | null
  resolvedDirectory: string
  source: string
  payload: Record<string, unknown>
}

async function readScrollCaptureStore(): Promise<{ latest?: ScrollCaptureRecord; recent: ScrollCaptureRecord[] }> {
  const file = Bun.file(SCROLL_CAPTURE_FILE)
  if (!(await file.exists())) return { recent: [] }
  try {
    const parsed = JSON.parse(await file.text())
    const latest = parsed && typeof parsed === "object" ? parsed.latest : undefined
    const recent =
      parsed && typeof parsed === "object" && Array.isArray(parsed.recent)
        ? parsed.recent.filter((item: unknown): item is ScrollCaptureRecord => !!item && typeof item === "object")
        : []
    return {
      latest: latest && typeof latest === "object" ? (latest as ScrollCaptureRecord) : undefined,
      recent,
    }
  } catch {
    return { recent: [] }
  }
}

async function writeScrollCapture(record: ScrollCaptureRecord) {
  const current = await readScrollCaptureStore()
  const next = {
    latest: record,
    recent: [record, ...current.recent].slice(0, MAX_SCROLL_CAPTURE_HISTORY),
  }
  await Bun.write(Bun.file(SCROLL_CAPTURE_FILE), JSON.stringify(next, null, 2))
}

function experimentalDebugBeacon(event: string, data: Record<string, unknown>) {
  // Kept for future RCA; disabled during normal operation.
  if (!EXPERIMENTAL_DEBUG_BEACON_ENABLED) return
  debugCheckpoint("web.debug", event, data)
}

function isZodSchemaLike(value: unknown): value is z.ZodType {
  return !!value && typeof value === "object" && "_def" in value
}

export const ExperimentalRoutes = lazy(() =>
  new Hono()
    .post(
      "/debug-beacon",
      describeRoute({
        summary: "Record frontend debug beacon",
        description: "Accept browser-side debug checkpoints and mirror them into debug.log for RCA.",
        operationId: "experimental.debug.beacon",
        responses: {
          200: {
            description: "Beacon recorded",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.literal(true) })),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          source: z.string().optional(),
          event: z.string(),
          directory: z.string().optional(),
          sessionID: z.string().optional(),
          messageID: z.string().optional(),
          payload: z.record(z.string(), z.any()).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        experimentalDebugBeacon(body.event, {
          source: body.source ?? "web",
          requestUser: RequestUser.username() ?? "local",
          resolvedDirectory: Instance.directory,
          directory: body.directory,
          sessionID: body.sessionID,
          messageID: body.messageID,
          ...(body.payload ?? {}),
        })
        return c.json({ ok: true as const })
      },
    )
    .post(
      "/client-diag",
      describeRoute({
        summary: "Record a one-shot client diagnostic snapshot",
        description:
          "Always-on (not gated by OPENCODE_DEBUG_BEACON) endpoint for a mobile-friendly 'diag button' — " +
          "the client collects its observable state (session message counts, last SSE event age, etc.) and " +
          "POSTs it here. Server writes an info-level log line tagged [client-diag] so it can be retrieved " +
          "by grep later during RCA. Intended for cases where the user cannot open browser DevTools (mobile).",
        operationId: "experimental.clientDiag",
        responses: {
          200: {
            description: "Snapshot recorded",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.literal(true),
                    serverReceivedAt: z.number(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          sessionID: z.string().optional(),
          note: z.string().optional(),
          snapshot: z.record(z.string(), z.any()).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const serverReceivedAt = Date.now()
        log.info("[client-diag]", {
          sessionID: body.sessionID ?? null,
          note: body.note ?? null,
          requestUser: RequestUser.username() ?? "local",
          snapshot: body.snapshot ?? {},
          serverReceivedAt,
        })
        return c.json({ ok: true as const, serverReceivedAt })
      },
    )
    .get(
      "/scroll-capture/latest",
      describeRoute({
        summary: "Get latest scroll incident capture",
        description: "Return the latest retained web scroll incident capture plus recent history.",
        operationId: "experimental.scrollCapture.latest",
        responses: {
          200: {
            description: "Latest scroll capture store",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    latest: z.record(z.string(), z.any()).optional(),
                    recent: z.array(z.record(z.string(), z.any())),
                    file: z.string(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const store = await readScrollCaptureStore()
        return c.json({
          ...store,
          file: SCROLL_CAPTURE_FILE,
        })
      },
    )
    .post(
      "/scroll-capture",
      describeRoute({
        summary: "Record scroll incident capture",
        description: "Persist a retained web scroll incident capture to a fixed server-side file for later RCA.",
        operationId: "experimental.scrollCapture.record",
        responses: {
          200: {
            description: "Scroll capture recorded",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.literal(true), file: z.string() })),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          source: z.string().optional(),
          capturedAt: z.number().optional(),
          payload: z.record(z.string(), z.any()),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const record: ScrollCaptureRecord = {
          capturedAt: body.capturedAt ?? Date.now(),
          requestUser: RequestUser.username() ?? null,
          resolvedDirectory: Instance.directory,
          source: body.source ?? "webapp.scroll-debug",
          payload: body.payload,
        }
        await writeScrollCapture(record)
        debugCheckpoint("scroll.capture", "recorded", {
          source: record.source,
          requestUser: record.requestUser,
          resolvedDirectory: record.resolvedDirectory,
          capturedAt: record.capturedAt,
          file: SCROLL_CAPTURE_FILE,
          marker: record.payload.marker,
          captureID: record.payload.captureID,
          kind: record.payload.kind,
        })
        return c.json({ ok: true as const, file: SCROLL_CAPTURE_FILE })
      },
    )
    .get(
      "/review-checkpoint",
      describeRoute({
        summary: "Review data-path checkpoint",
        description: "Return resolved directory/user/git status diagnostics for review panel debugging.",
        operationId: "experimental.review.checkpoint",
        responses: {
          200: {
            description: "Review checkpoint",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    requestUser: z.string().nullable(),
                    directory: z.string(),
                    worktree: z.string(),
                    project: z.object({
                      id: z.string(),
                      vcs: z.string().optional(),
                      name: z.string().optional(),
                    }),
                    statusCount: z.number(),
                    statusSample: z.array(File.Info).max(20),
                    git: z.object({
                      diffNumstatExit: z.number(),
                      diffNumstatErr: z.string(),
                      porcelainExit: z.number(),
                      porcelainErr: z.string(),
                      porcelainSample: z.string(),
                    }),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        if (process.env.OPENCODE_DEBUG_REVIEW_CHECKPOINT !== "1") {
          return c.json({ code: "CHECKPOINT_DISABLED", message: "review checkpoint disabled" }, 404)
        }

        const status = await File.status()
        const diffNumstat = await git(["-c", "safe.directory=*", "diff", "--numstat", "HEAD"], {
          cwd: Instance.directory,
        })
        const porcelain = await git(["-c", "safe.directory=*", "status", "--porcelain"], {
          cwd: Instance.directory,
        })

        const text = async (input: Buffer | ReadableStream<Uint8Array>) =>
          Buffer.isBuffer(input) ? input.toString() : Bun.readableStreamToText(input)

        return c.json({
          requestUser: RequestUser.username() ?? null,
          directory: Instance.directory,
          worktree: Instance.worktree,
          project: {
            id: Instance.project.id,
            vcs: Instance.project.vcs,
            name: Instance.project.name,
          },
          statusCount: status.length,
          statusSample: status.slice(0, 20),
          git: {
            diffNumstatExit: diffNumstat.exitCode,
            diffNumstatErr: (await text(diffNumstat.stderr)).trim().slice(0, 500),
            porcelainExit: porcelain.exitCode,
            porcelainErr: (await text(porcelain.stderr)).trim().slice(0, 500),
            porcelainSample: (await text(porcelain.stdout)).trim().slice(0, 1000),
          },
        })
      },
    )
    .get(
      "/user-daemon",
      describeRoute({
        summary: "Get per-user daemon snapshots",
        description: "Return observed per-user daemon socket state for diagnostics.",
        operationId: "experimental.userDaemon.list",
        responses: {
          200: {
            description: "Per-user daemon snapshots",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      username: z.string(),
                      uid: z.number(),
                      port: z.number(),
                      socketPath: z.string(),
                      status: z.enum(["planned", "starting", "ready", "missing"]),
                      firstSeenAt: z.number(),
                      lastSeenAt: z.number(),
                      lastStartAttemptAt: z.number().optional(),
                      startAttempts: z.number(),
                      lastStartError: z.string().optional(),
                    }),
                  ),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(UserDaemonManager.list())
      },
    )
    .get(
      "/tool/ids",
      describeRoute({
        summary: "List tool IDs",
        description:
          "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
        operationId: "tool.ids",
        responses: {
          200: {
            description: "Tool IDs",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string()).meta({ ref: "ToolIDs" })),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        return c.json(await ToolRegistry.ids())
      },
    )
    .get(
      "/tool",
      describeRoute({
        summary: "List tools",
        description:
          "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
        operationId: "tool.list",
        responses: {
          200: {
            description: "Tools",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .array(
                      z
                        .object({
                          id: z.string(),
                          description: z.string(),
                          parameters: z.any(),
                        })
                        .meta({ ref: "ToolListItem" }),
                    )
                    .meta({ ref: "ToolList" }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          provider: z.string(),
          model: z.string(),
        }),
      ),
      async (c) => {
        const { provider, model } = c.req.valid("query")
        const tools = await ToolRegistry.tools({ providerId: provider, modelID: model })
        return c.json(
          tools.map((t) => ({
            id: t.id,
            description: t.description,
            // Handle both Zod schemas and plain JSON schemas
            parameters: isZodSchemaLike(t.parameters) ? zodToJsonSchema(t.parameters) : t.parameters,
          })),
        )
      },
    )
    .post(
      "/worktree",
      describeRoute({
        summary: "Create worktree",
        description: "Create a new git worktree for the current project and run any configured startup scripts.",
        operationId: "worktree.create",
        responses: {
          200: {
            description: "Worktree created",
            content: {
              "application/json": {
                schema: resolver(Worktree.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.create.schema),
      async (c) => {
        const body = c.req.valid("json")
        const worktree = await Worktree.create(body)
        return c.json(worktree)
      },
    )
    .get(
      "/worktree",
      describeRoute({
        summary: "List worktrees",
        description: "List all sandbox worktrees for the current project.",
        operationId: "worktree.list",
        responses: {
          200: {
            description: "List of worktree directories",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string())),
              },
            },
          },
        },
      }),
      async (c) => {
        const sandboxes = await Project.sandboxes(Instance.project.id)
        return c.json(sandboxes)
      },
    )
    .delete(
      "/worktree",
      describeRoute({
        summary: "Remove worktree",
        description: "Remove a git worktree and delete its branch.",
        operationId: "worktree.remove",
        responses: {
          200: {
            description: "Worktree removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.remove.schema),
      async (c) => {
        const body = c.req.valid("json")
        await Worktree.remove(body)
        await Project.removeSandbox(Instance.project.id, body.directory)
        return c.json(true)
      },
    )
    .post(
      "/worktree/reset",
      describeRoute({
        summary: "Reset worktree",
        description: "Reset a worktree branch to the primary default branch.",
        operationId: "worktree.reset",
        responses: {
          200: {
            description: "Worktree reset",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.reset.schema),
      async (c) => {
        const body = c.req.valid("json")
        await Worktree.reset(body)
        return c.json(true)
      },
    )
    .get(
      "/session",
      describeRoute({
        summary: "List sessions",
        description:
          "Get a list of all OpenCMS sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
        operationId: "experimental.session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.GlobalInfo.array()),
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
          cursor: z.coerce
            .number()
            .optional()
            .meta({ description: "Return sessions updated before this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
          archived: z.coerce.boolean().optional().meta({ description: "Include archived sessions (default false)" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const limit = query.limit ?? 100
        const sessions: Session.GlobalInfo[] = []
        for await (const session of Session.listGlobal({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          cursor: query.cursor,
          search: query.search,
          limit: limit + 1,
          archived: query.archived,
        })) {
          sessions.push(session)
        }
        const hasMore = sessions.length > limit
        const list = hasMore ? sessions.slice(0, limit) : sessions
        if (hasMore && list.length > 0) {
          c.header("x-next-cursor", String(list[list.length - 1].time.updated))
        }
        return c.json(list)
      },
    )
    .get(
      "/resource",
      describeRoute({
        summary: "Get MCP resources",
        description: "Get all available MCP resources from connected servers. Optionally filter by name.",
        operationId: "experimental.resource.list",
        responses: {
          200: {
            description: "MCP resources",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Resource)),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await MCP.resources())
      },
    ),
)
