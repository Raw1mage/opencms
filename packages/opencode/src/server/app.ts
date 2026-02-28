import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { describeRoute, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { proxy } from "hono/proxy"
import path from "path"
import fs from "fs"
import z from "zod"
import { Provider } from "../provider/provider"
import { NamedError } from "@opencode-ai/util/error"
import { LSP } from "../lsp"
import { Format } from "../format"
import { TuiRoutes } from "./routes/tui"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { Agent } from "../agent/agent"
import { Skill } from "../skill/skill"
import { Auth } from "../auth"
import { Flag } from "../flag/flag"
import { Command } from "../command"
import { Global } from "../global"
import { ProjectRoutes } from "./routes/project"
import { SessionRoutes } from "./routes/session"
import { PtyRoutes } from "./routes/pty"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes } from "./routes/file"
import { ConfigRoutes } from "./routes/config"
import { ExperimentalRoutes } from "./routes/experimental"
import { ProviderRoutes } from "./routes/provider"
import { InstanceBootstrap } from "../project/bootstrap"
import { Storage } from "../storage/storage"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { HTTPException } from "hono/http-exception"
import { errors } from "./error"
import { QuestionRoutes } from "./routes/question"
import { PermissionRoutes } from "./routes/permission"
import { GlobalRoutes } from "./routes/global"
import { AccountRoutes } from "./routes/account"
import { RotationRoutes } from "./routes/rotation"
import { ModelRoutes } from "./routes/model"
import { Env } from "@/env"
import { ActivityBeacon } from "@/util/activity-beacon"
import { WebAuth } from "./web-auth"

// Declare external CORS whitelist (set by server.ts)
declare global {
  var __CORS_WHITELIST: string[]
}

const log = Log.create({ service: "server" })
const beacon = ActivityBeacon.scope("server.app")

/**
 * Initialize and configure the Hono application with all middleware and routes.
 * This is extracted from server.ts to fix TypeScript type inference issues with lazy().
 */
export function createApp(app: Hono): Hono {
  app.onError((err, c) => {
    log.error("failed", {
      error: err,
    })
    if (err instanceof NamedError) {
      let status: ContentfulStatusCode
      if (err instanceof Storage.NotFoundError) status = 404
      else if (err instanceof Provider.ModelNotFoundError) status = 400
      else if (err.name.startsWith("Worktree")) status = 400
      else status = 500
      return c.json(err.toObject(), { status })
    }
    if (err instanceof HTTPException) return err.getResponse()
    const message = err instanceof Error && err.stack ? err.stack : err.toString()
    return c.json(new NamedError.Unknown({ message }).toObject(), {
      status: 500,
    })
  })

  app.use(
    cors({
      credentials: true,
      origin(input) {
        if (!input) return

        if (input.startsWith("http://localhost:")) return input
        if (input.startsWith("http://127.0.0.1:")) return input
        if (input === "tauri://localhost" || input === "http://tauri.localhost") return input

        // *.opencode.ai (https only, adjust if needed)
        if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) {
          return input
        }
        if (globalThis.__CORS_WHITELIST?.includes(input)) {
          return input
        }

        return
      },
    }),
  )

  app.use(async (c, next) => {
    if (!WebAuth.enabled()) return next()
    if (WebAuth.routePublic(c)) return next()

    if (await WebAuth.verifyBasicAuth(c)) {
      return next()
    }

    const session = WebAuth.readSession(c)
    if (!session) {
      return c.json(
        {
          code: "AUTH_REQUIRED",
          message: "Authentication required",
        },
        401,
      )
    }

    if (WebAuth.shouldProtectMutation(c.req.method, c.req.path)) {
      const csrf = c.req.header("x-opencode-csrf")
      if (!csrf || csrf !== session.csrf) {
        return c.json(
          {
            code: "CSRF_INVALID",
            message: "Invalid CSRF token",
          },
          403,
        )
      }
    }

    return next()
  })

  app.use(async (c, next) => {
    beacon.hit("request")
    const skipLogging = c.req.path === "/log" || c.req.path.endsWith("/log")
    if (!skipLogging) {
      log.info("request", {
        method: c.req.method,
        path: c.req.path,
      })
    }
    const timer = log.time("request", {
      method: c.req.method,
      path: c.req.path,
    })
    await next()
    if (!skipLogging) {
      timer.stop()
    }
  })

  app.use(async (c, next) => {
    if (c.req.path === "/log" || c.req.path.endsWith("/log")) return next()
    const directoryFromQuery = c.req.query("directory")
    const directoryFromHeader = c.req.header("x-opencode-directory")
    const hasDirectoryOverride = Boolean(directoryFromQuery || directoryFromHeader)
    const requestHost = (() => {
      try {
        return new URL(c.req.url).hostname
      } catch {
        return ""
      }
    })()
    const isLoopbackHost =
      requestHost === "localhost" || requestHost === "127.0.0.1" || requestHost === "::1" || requestHost === "[::1]"

    const requestSecured = Boolean(Flag.OPENCODE_SERVER_PASSWORD) || WebAuth.enabled()
    const globalBrowseEnabled =
      Bun.env.OPENCODE_ALLOW_GLOBAL_FS_BROWSE === "1" || Bun.env.OPENCODE_ALLOW_GLOBAL_FS_BROWSE === "true"
    const allowDirectoryOverride = isLoopbackHost || requestSecured || globalBrowseEnabled

    const raw =
      hasDirectoryOverride && !allowDirectoryOverride
        ? process.cwd()
        : (directoryFromQuery ?? directoryFromHeader ?? process.cwd())

    if (hasDirectoryOverride && !allowDirectoryOverride) {
      log.warn("Ignoring directory override on unsecured request", {
        path: c.req.path,
        host: requestHost,
        secured: requestSecured,
        globalBrowseEnabled,
      })
    }
    const directory = await (async () => {
      const decoded = (() => {
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      })()
      const exists = await fs.promises
        .access(decoded)
        .then(() => true)
        .catch(() => false)
      if (exists) return decoded
      log.warn("Directory does not exist, falling back to process.cwd()", {
        requested: decoded,
        fallback: process.cwd(),
      })
      return process.cwd()
    })()

    // Always tell the client the canonical directory that was actually used,
    // so stale localStorage entries can be auto-healed on the client side.
    c.header("X-Opencode-Resolved-Directory", directory)

    return Instance.provide({
      directory,
      init: InstanceBootstrap,
      async fn() {
        return next()
      },
    })
  })

  // Create API group for dual mounting
  const api = new Hono()

  api.route("/global", GlobalRoutes())

  api.put(
    "/auth/:providerId",
    describeRoute({
      summary: "Set auth credentials",
      description: "Set authentication credentials",
      operationId: "auth.set",
      responses: {
        200: {
          description: "Successfully set authentication credentials",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "param",
      z.object({
        providerId: z.string(),
      }),
    ),
    validator("json", Auth.Info),
    async (c) => {
      const providerId = c.req.valid("param").providerId
      const info = c.req.valid("json")
      await Auth.set(providerId, info)
      return c.json(true)
    },
  )

  api.delete(
    "/auth/:providerId",
    describeRoute({
      summary: "Remove auth credentials",
      description: "Remove authentication credentials",
      operationId: "auth.remove",
      responses: {
        200: {
          description: "Successfully removed authentication credentials",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "param",
      z.object({
        providerId: z.string(),
      }),
    ),
    async (c) => {
      const providerId = c.req.valid("param").providerId
      await Auth.remove(providerId)
      return c.json(true)
    },
  )

  api.get(
    "/doc",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "opencode",
          version: "0.0.3",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    }),
  )

  api.use(validator("query", z.object({ directory: z.string().optional() })))
  api.route("/project", ProjectRoutes())
  api.route("/pty", PtyRoutes())
  api.route("/config", ConfigRoutes())
  api.route("/experimental", ExperimentalRoutes())
  api.route("/session", SessionRoutes())
  api.route("/permission", PermissionRoutes())
  api.route("/question", QuestionRoutes())
  api.route("/provider", ProviderRoutes())
  api.route("/mcp", McpRoutes())
  api.route("/tui", TuiRoutes())
  api.route("/account", AccountRoutes())
  api.route("/accounts", AccountRoutes())
  api.route("/rotation", RotationRoutes())
  api.route("/model", ModelRoutes())
  api.route("/", FileRoutes())

  api.post(
    "/instance/dispose",
    describeRoute({
      summary: "Dispose instance",
      description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
      operationId: "instance.dispose",
      responses: {
        200: {
          description: "Instance disposed",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
      },
    }),
    async (c) => {
      await Instance.dispose()
      return c.json(true)
    },
  )

  api.get(
    "/path",
    describeRoute({
      summary: "Get paths",
      description: "Retrieve the current working directory and related path information for the OpenCode instance.",
      operationId: "path.get",
      responses: {
        200: {
          description: "Path",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    home: z.string(),
                    state: z.string(),
                    config: z.string(),
                    worktree: z.string(),
                    directory: z.string(),
                  })
                  .meta({
                    ref: "Path",
                  }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json({
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: Instance.worktree,
        directory: Instance.directory,
      })
    },
  )

  api.get(
    "/vcs",
    describeRoute({
      summary: "Get VCS info",
      description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
      operationId: "vcs.get",
      responses: {
        200: {
          description: "VCS info",
          content: {
            "application/json": {
              schema: resolver(Vcs.Info),
            },
          },
        },
      },
    }),
    async (c) => {
      const branch = await Vcs.branch()
      return c.json({
        branch,
      })
    },
  )

  api.get(
    "/command",
    describeRoute({
      summary: "List commands",
      description: "Get a list of all available commands in the OpenCode system.",
      operationId: "command.list",
      responses: {
        200: {
          description: "List of commands",
          content: {
            "application/json": {
              schema: resolver(Command.Info.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const commands = await Command.list()
      return c.json(commands)
    },
  )

  api.post(
    "/log",
    describeRoute({
      summary: "Write log",
      description: "Write a log entry to the server logs with specified level and metadata.",
      operationId: "app.log",
      responses: {
        200: {
          description: "Log entry written successfully",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        service: z.string().meta({ description: "Service name for the log entry" }),
        level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
        message: z.string().meta({ description: "Log message" }),
        extra: z.record(z.string(), z.any()).optional().meta({ description: "Additional metadata for the log entry" }),
      }),
    ),
    async (c) => {
      const { service, level, message, extra } = c.req.valid("json")
      const logger = Log.create({ service })

      switch (level) {
        case "debug":
          logger.debug(message, extra)
          break
        case "info":
          logger.info(message, extra)
          break
        case "error":
          logger.error(message, extra)
          break
        case "warn":
          logger.warn(message, extra)
          break
      }

      return c.json(true)
    },
  )

  api.get(
    "/agent",
    describeRoute({
      summary: "List agents",
      description: "Get a list of all available AI agents in the OpenCode system.",
      operationId: "app.agents",
      responses: {
        200: {
          description: "List of agents",
          content: {
            "application/json": {
              schema: resolver(Agent.Info.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const modes = await Agent.list()
      return c.json(modes)
    },
  )

  api.get(
    "/skill",
    describeRoute({
      summary: "List skills",
      description: "Get a list of all available skills in the OpenCode system.",
      operationId: "app.skills",
      responses: {
        200: {
          description: "List of skills",
          content: {
            "application/json": {
              schema: resolver(Skill.Info.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const skills = await Skill.all()
      return c.json(skills)
    },
  )

  api.get(
    "/lsp",
    describeRoute({
      summary: "Get LSP status",
      description: "Get LSP server status",
      operationId: "lsp.status",
      responses: {
        200: {
          description: "LSP server status",
          content: {
            "application/json": {
              schema: resolver(LSP.Status.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await LSP.status())
    },
  )

  api.get(
    "/formatter",
    describeRoute({
      summary: "Get formatter status",
      description: "Get formatter status",
      operationId: "formatter.status",
      responses: {
        200: {
          description: "Formatter status",
          content: {
            "application/json": {
              schema: resolver(Format.Status.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await Format.status())
    },
  )

  api.get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(BusEvent.payloads()),
            },
          },
        },
      },
    }),
    async (c) => {
      beacon.hit("event.connected")
      log.info("event connected")
      return streamSSE(c, async (stream) => {
        stream.writeSSE({
          data: JSON.stringify({
            type: "server.connected",
            properties: {},
          }),
        })
        const unsub = Bus.subscribeAll(async (event) => {
          beacon.hit("event.publish")
          await stream.writeSSE({
            data: JSON.stringify(event),
          })
          if (event.type === Bus.InstanceDisposed.type) {
            stream.close()
          }
        })

        // Send heartbeat every 30s to prevent WKWebView timeout (60s default)
        const heartbeat = setInterval(() => {
          beacon.hit("event.heartbeat")
          stream.writeSSE({
            data: JSON.stringify({
              type: "server.heartbeat",
              properties: {},
            }),
          })
        }, 30000)

        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            clearInterval(heartbeat)
            unsub()
            resolve()
            beacon.hit("event.disconnected")
            log.info("event disconnected")
          })
        })
      })
    },
  )

  // Dual-mount the API
  app.route("/api/v2", api)
  app.route("/", api)

  // Resolve XDG frontend path once per process (cached)
  let xdgFrontendPath: string | undefined
  let xdgFrontendChecked = false
  const resolveXdgFrontend = async () => {
    if (xdgFrontendChecked) return xdgFrontendPath
    xdgFrontendChecked = true
    const candidate = Global.Path.frontend
    if (await Bun.file(path.join(candidate, "index.html")).exists()) {
      xdgFrontendPath = candidate
    }
    return xdgFrontendPath
  }

  // Frontend catch-all
  app.get("/*", async (c, next) => {
    // Resolve frontend path: explicit env > XDG data dir > CDN proxy
    const frontendPath = Env.get("OPENCODE_FRONTEND_PATH") ?? (await resolveXdgFrontend())
    if (frontendPath) {
      const resolvedFrontendPath = path.resolve(frontendPath)
      const reqPath = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\/+/, "")
      const filePath = path.resolve(resolvedFrontendPath, reqPath)
      const withinFrontendRoot =
        filePath === resolvedFrontendPath || filePath.startsWith(resolvedFrontendPath + path.sep)

      if (!withinFrontendRoot) {
        log.warn("Rejected frontend file request outside configured frontend root", {
          reqPath: c.req.path,
          frontendPath: resolvedFrontendPath,
        })
        return next()
      }

      const ext = path.extname(filePath).toLowerCase()
      const file = Bun.file(filePath)
      if (await file.exists()) {
        const contentTypes: Record<string, string> = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
          ".wasm": "application/wasm",
        }
        return new Response(file, {
          headers: {
            "Content-Type": contentTypes[ext] || "application/octet-stream",
            "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000",
          },
        })
      }
      // For SPA routing, serve index.html for non-file paths
      if (!ext || ext === "") {
        const indexPath = path.resolve(resolvedFrontendPath, "index.html")
        const indexFile = Bun.file(indexPath)
        if (await indexFile.exists()) {
          return new Response(indexFile, {
            headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
          })
        }
      }
    }

    // Fallback to proxy
    const response = await proxy(`https://app.opencode.ai${c.req.path}`, {
      ...c.req,
      headers: {
        ...c.req.raw.headers,
        host: "app.opencode.ai",
      },
    })
    response.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:",
    )
    return response
  })

  return app
}
