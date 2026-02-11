import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { describeRoute, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { proxy } from "hono/proxy"
import { basicAuth } from "hono/basic-auth"
import path from "path"
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
import { Env } from "@/env"

// Declare external CORS whitelist (set by server.ts)
declare global {
  var __CORS_WHITELIST: string[]
}

const log = Log.create({ service: "server" })

/**
 * Initialize and configure the Hono application with all middleware and routes.
 * This is extracted from server.ts to fix TypeScript type inference issues with lazy().
 */
export function createApp(app: Hono): Hono {
  return app
    .onError((err, c) => {
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
    .use(
      cors({
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
    .use((c, next) => {
      // Skip auth for health check endpoint (Docker/k8s health probes)
      if (c.req.path === "/global/health") return next()
      const password = Flag.OPENCODE_SERVER_PASSWORD
      if (!password) return next()
      const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
      return basicAuth({ username, password })(c, next)
    })
    .use(async (c, next) => {
      const skipLogging = c.req.path === "/log"
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
    .route("/global", GlobalRoutes())
    .put(
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
    .delete(
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
    .use(async (c, next) => {
      if (c.req.path === "/log") return next()
      const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
      const directory = (() => {
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      })()
      return Instance.provide({
        directory,
        init: InstanceBootstrap,
        async fn() {
          return next()
        },
      })
    })
    .get(
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
    .use(validator("query", z.object({ directory: z.string().optional() })))
    .route("/project", ProjectRoutes())
    .route("/pty", PtyRoutes())
    .route("/config", ConfigRoutes())
    .route("/experimental", ExperimentalRoutes())
    .route("/session", SessionRoutes())
    .route("/permission", PermissionRoutes())
    .route("/question", QuestionRoutes())
    .route("/provider", ProviderRoutes())
    .route("/mcp", McpRoutes())
    .route("/tui", TuiRoutes())
    .route("/account", AccountRoutes())
    .route("/accounts", AccountRoutes())
    .route("/rotation", RotationRoutes())
    .route("/", FileRoutes())
    .post(
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
    .get(
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
    .get(
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
    .get(
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
    .post(
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
          extra: z
            .record(z.string(), z.any())
            .optional()
            .meta({ description: "Additional metadata for the log entry" }),
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
    .get(
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
    .get(
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
    .get(
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
    .get(
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
    .get(
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
        log.info("event connected")
        return streamSSE(c, async (stream) => {
          stream.writeSSE({
            data: JSON.stringify({
              type: "server.connected",
              properties: {},
            }),
          })
          const unsub = Bus.subscribeAll(async (event) => {
            await stream.writeSSE({
              data: JSON.stringify(event),
            })
            if (event.type === Bus.InstanceDisposed.type) {
              stream.close()
            }
          })

          // Send heartbeat every 30s to prevent WKWebView timeout (60s default)
          const heartbeat = setInterval(() => {
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
              log.info("event disconnected")
            })
          })
        })
      },
    )
    .get("/*", async (c, next) => {
      // Try to serve local frontend if OPENCODE_FRONTEND_PATH is set
      const frontendPath = Env.get("OPENCODE_FRONTEND_PATH")
      if (frontendPath) {
        const reqPath = c.req.path === "/" ? "/index.html" : c.req.path
        const filePath = path.join(frontendPath, reqPath)
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
          const indexPath = path.join(frontendPath, "index.html")
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
    }) as unknown as Hono
}
