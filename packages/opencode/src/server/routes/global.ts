import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import path from "node:path"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Instance } from "../../project/instance"
import { Installation } from "@/installation"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { errors } from "../error"
import { WebAuth } from "../web-auth"

const log = Log.create({ service: "server" })

function resolveWebctlPath() {
  if (process.env.OPENCODE_WEBCTL_PATH) return process.env.OPENCODE_WEBCTL_PATH
  if (process.env.OPENCODE_LAUNCH_MODE === "webctl" && process.env.OPENCODE_REPO_ROOT) {
    return path.join(process.env.OPENCODE_REPO_ROOT, "webctl.sh")
  }
  return "/etc/opencode/webctl.sh"
}

function applyProxyFriendlySSEHeaders(c: { header: (name: string, value: string) => void }) {
  c.header("Cache-Control", "no-cache, no-store, must-revalidate, no-transform")
  c.header("Pragma", "no-cache")
  c.header("X-Accel-Buffering", "no")
  c.header("Connection", "keep-alive")
}

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the OpenCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        // Import dynamically to avoid circular deps at module load
        const { Daemon } = await import("@/daemon")

        const daemonInfo = Daemon.info()

        return c.json({
          healthy: true,
          version: Installation.VERSION,
          daemon: {
            state: daemonInfo.state,
            activeTasks: daemonInfo.activeTasks,
            lanes: daemonInfo.lanes,
          },
        })
      },
    )
    .get(
      "/auth/session",
      describeRoute({
        summary: "Get web auth session",
        description: "Get current web authentication status and CSRF token when authenticated.",
        operationId: "global.auth.session",
        responses: {
          200: {
            description: "Web auth session status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    enabled: z.boolean(),
                    authenticated: z.boolean(),
                    usernameHint: z.string().optional(),
                    username: z.string().optional(),
                    csrfToken: z.string().optional(),
                    lockout: z
                      .object({
                        lockedUntil: z.number(),
                        retryAfterSeconds: z.number(),
                      })
                      .optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        if (!WebAuth.enabled()) {
          return c.json({ enabled: false, authenticated: true })
        }

        const session = WebAuth.readSession(c)
        if (!session) {
          return c.json({
            enabled: true,
            authenticated: false,
            usernameHint: WebAuth.username(),
            lockout: WebAuth.lockStatus(c, WebAuth.username()),
          })
        }

        return c.json({
          enabled: true,
          authenticated: true,
          username: session.username,
          csrfToken: session.csrf,
        })
      },
    )
    .post(
      "/auth/login",
      describeRoute({
        summary: "Login web session",
        description: "Authenticate with server credentials and issue an HttpOnly session cookie.",
        operationId: "global.auth.login",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["username", "password"],
                properties: {
                  username: { type: "string", minLength: 1 },
                  password: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Login success",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.literal(true),
                    username: z.string(),
                    csrfToken: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(401, 429),
        },
      }),
      validator(
        "json",
        z.object({
          username: z.string().min(1),
          password: z.string().min(1),
        }),
      ),
      async (c) => {
        if (!WebAuth.enabled()) {
          return c.json({ ok: true, username: "", csrfToken: "" })
        }

        const body = c.req.valid("json")
        const lock = WebAuth.lockStatus(c, body.username)
        if (lock) {
          c.header("Retry-After", String(lock.retryAfterSeconds))
          return c.json(
            {
              code: "AUTH_LOCKED",
              message: "Too many failed attempts",
              ...lock,
            },
            429,
          )
        }

        if (!(await WebAuth.verifyCredentials(body.username, body.password))) {
          WebAuth.markFailure(c, body.username)
          return c.json(
            {
              code: "AUTH_INVALID",
              message: "Invalid username or password",
            },
            401,
          )
        }

        WebAuth.markSuccess(c, body.username)
        const issued = WebAuth.issue(body.username)
        c.header("Set-Cookie", WebAuth.cookieHeader(c, issued.token, 60 * 60 * 8))
        return c.json({ ok: true, username: issued.payload.username, csrfToken: issued.payload.csrf })
      },
    )
    .post(
      "/auth/logout",
      describeRoute({
        summary: "Logout web session",
        description: "Invalidate current web auth session cookie.",
        operationId: "global.auth.logout",
        responses: {
          200: {
            description: "Logout success",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.literal(true) })),
              },
            },
          },
        },
      }),
      async (c) => {
        if (WebAuth.enabled()) {
          const session = WebAuth.readSession(c)
          WebAuth.invalidate(session)
          c.header("Set-Cookie", WebAuth.clearCookieHeader(c))
        }
        return c.json({ ok: true })
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the OpenCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      payload: BusEvent.payloads(),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        applyProxyFriendlySSEHeaders(c)
        return streamSSE(c, async (stream) => {
          await stream.writeSSE({
            data: JSON.stringify({
              payload: {
                type: "server.connected",
                properties: {},
              },
            }),
          })
          async function handler(event: any) {
            await stream.writeSSE({
              data: JSON.stringify(event),
            })
          }
          GlobalBus.on("event", handler)

          // Send heartbeat every 30s to prevent WKWebView timeout (60s default)
          const heartbeat = setInterval(() => {
            void stream.writeSSE({
              data: JSON.stringify({
                payload: {
                  type: "server.heartbeat",
                  properties: {},
                },
              }),
            })
          }, 30000)

          await new Promise<void>((resolve) => {
            stream.onAbort(() => {
              clearInterval(heartbeat)
              GlobalBus.off("event", handler)
              resolve()
              log.info("global event disconnected")
            })
          })
        })
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global OpenCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.getGlobal())
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global OpenCode configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        const next = await Config.updateGlobal(config)
        return c.json(next)
      },
    )
    .post(
      "/web/restart",
      describeRoute({
        summary: "Restart web runtime",
        description:
          "Schedule a controlled web runtime restart. Intended for authenticated operators; clients should wait for health recovery and then reload.",
        operationId: "global.web.restart",
        responses: {
          200: {
            description: "Restart accepted",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.literal(true),
                    accepted: z.literal(true),
                    mode: z.literal("controlled_restart"),
                    probePath: z.literal("/api/v2/global/health"),
                    recommendedInitialDelayMs: z.number(),
                    fallbackReloadAfterMs: z.number(),
                  }),
                ),
              },
            },
          },
          ...errors(500),
        },
      }),
      async (c) => {
        const webctlPath = resolveWebctlPath()
        const txid = `web-${Date.now()}-${process.pid}`
        const runtimeTmp = process.env.XDG_RUNTIME_DIR || "/tmp"
        const errorLogPath = path.join(runtimeTmp, `opencode-web-restart-${txid}.error.log`)
        const exists = await Bun.file(webctlPath).exists()
        if (!exists) {
          log.error("web restart rejected: control script missing", { webctlPath })
          return c.json(
            {
              code: "WEBCTL_MISSING",
              message: `web control script not found: ${webctlPath}`,
            },
            500,
          )
        }

        const proc = Bun.spawn({
          cmd: [webctlPath, "restart", "--graceful"],
          stdout: "ignore",
          stderr: "pipe",
          stdin: "ignore",
          env: {
            ...process.env,
            OPENCODE_RESTART_TXID: txid,
            OPENCODE_RESTART_ERROR_LOG_FILE: errorLogPath,
          },
        })
        const stderrText = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("")
        const exitCode = await proc.exited
        const stderr = (await stderrText).trim()
        if (exitCode !== 0) {
          const hint =
            process.env.OPENCODE_LAUNCH_MODE === "webctl"
              ? "Current runtime appears to be webctl/dev mode; restart may rebuild frontend before restarting. See the restart error log for full output."
              : undefined
          log.error("web restart failed to schedule", { webctlPath, exitCode, stderr, txid, errorLogPath })
          return c.json(
            {
              code: "WEB_RESTART_FAILED",
              message: stderr || `web restart command failed (${exitCode})`,
              exitCode,
              hint,
              webctlPath,
              txid,
              errorLogPath,
            },
            500,
          )
        }

        return c.json({
          ok: true,
          accepted: true,
          mode: "controlled_restart",
          probePath: "/api/v2/global/health",
          txid,
          recommendedInitialDelayMs: 1500,
          fallbackReloadAfterMs: 10000,
        })
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.disposeAll()
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalDisposedEvent.type,
            properties: {},
          },
        })
        return c.json(true)
      },
    ),
)
