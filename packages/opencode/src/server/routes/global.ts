import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import path from "node:path"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { getLogLevel, setLogLevel, LOG_LEVELS, type LogLevel } from "@/bus/log-level"
import { Instance } from "../../project/instance"
import { Installation } from "@/installation"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { Tweaks } from "../../config/tweaks"
import { errors } from "../error"
import { WebAuth } from "../web-auth"

const log = Log.create({ service: "server" })

type RestartRuntimeMode = "dev-source" | "dev-standalone" | "service" | "gateway-daemon" | "unknown"

function resolveRestartRuntimeMode(): RestartRuntimeMode {
  const launchMode = process.env.OPENCODE_LAUNCH_MODE
  if (launchMode === "webctl") {
    return process.env.OPENCODE_REPO_ROOT ? "dev-source" : "dev-standalone"
  }
  if (launchMode === "service") return "service"
  return "unknown"
}

/** True when this process is a per-user daemon spawned by the C root gateway. */
function isGatewayDaemon(): boolean {
  return process.env.OPENCODE_USER_DAEMON_MODE === "1"
}

function resolveWebctlPath() {
  if (process.env.OPENCODE_LAUNCH_MODE === "webctl" && process.env.OPENCODE_REPO_ROOT) {
    return path.join(process.env.OPENCODE_REPO_ROOT, "webctl.sh")
  }
  if (process.env.OPENCODE_WEBCTL_PATH) return process.env.OPENCODE_WEBCTL_PATH
  return "/etc/opencode/webctl.sh"
}

function applyProxyFriendlySSEHeaders(c: { header: (name: string, value: string) => void }) {
  c.header("Cache-Control", "no-cache, no-store, must-revalidate, no-transform")
  c.header("Pragma", "no-cache")
  c.header("X-Accel-Buffering", "no")
  c.header("Connection", "keep-alive")
}

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

// SSE is live-only: no ring buffer, no Last-Event-ID resume, no bounded
// replay. Missed events during drops are lost — clients recover by
// re-entering the route (tail-first hydrate). Counter is retained only to
// stamp outgoing frames with a monotonic id for debug correlation.
let _sseCounter = 0
let _sseConnectionCount = 0

function sseNextId(): number {
  return ++_sseCounter
}

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
        // Also clear gateway JWT cookie so the C root gateway sees the
        // user as unauthenticated on the next request.
        const secure = c.req.url.startsWith("https")
        c.header("Set-Cookie", `oc_jwt=; Path=/; Max-Age=0${secure ? "; Secure" : ""}`, { append: true })
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
        _sseConnectionCount++
        const connId = _sseConnectionCount
        console.error(`[SSE-CONN] #${connId} connected (active=${_sseConnectionCount})`)
        log.info("global event connected")
        applyProxyFriendlySSEHeaders(c)

        return streamSSE(c, async (stream) => {
          const connectedId = sseNextId()
          await stream.writeSSE({
            id: String(connectedId),
            data: JSON.stringify({
              payload: { type: "server.connected", properties: {} },
            }),
          })

          const _sseMetrics = { partUpdates: 0, totalBytes: 0 }

          async function handler(event: unknown) {
            const id = sseNextId()
            const data = JSON.stringify(event)

            // [DELTA-SSE] instrumentation: measure message.part.updated event sizes
            const payload = (event as any)?.payload
            if (payload?.type === "message.part.updated") {
              _sseMetrics.partUpdates++
              _sseMetrics.totalBytes += data.length
              if (_sseMetrics.partUpdates % 50 === 0) {
                const avgBytes = Math.round(_sseMetrics.totalBytes / _sseMetrics.partUpdates)
                console.error(
                  `[DELTA-SSE] partUpdates=${_sseMetrics.partUpdates} totalBytes=${_sseMetrics.totalBytes} avgBytes=${avgBytes} thisBytes=${data.length}`,
                )
              }
            }

            await stream.writeSSE({
              id: String(id),
              data,
            })
          }
          GlobalBus.on("event", handler)

          // Send heartbeat every 30s to prevent WKWebView timeout (60s default)
          const heartbeat = setInterval(() => {
            void stream.writeSSE({
              data: JSON.stringify({
                payload: { type: "server.heartbeat", properties: {} },
              }),
            })
          }, 30000)

          await new Promise<void>((resolve) => {
            stream.onAbort(() => {
              clearInterval(heartbeat)
              GlobalBus.off("event", handler)
              _sseConnectionCount--
              console.error(`[SSE-CONN] #${connId} disconnected (active=${_sseConnectionCount})`)
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
    .delete(
      "/config/provider/:providerId",
      describeRoute({
        summary: "Delete custom provider from global configuration",
        description: "Remove a custom provider entry from the global OpenCode configuration.",
        operationId: "global.config.provider.delete",
        responses: {
          200: {
            description: "Successfully removed provider from global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerId: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      async (c) => {
        const { providerId } = c.req.valid("param")
        const next = await Config.removeGlobalProvider(providerId)
        return c.json(next)
      },
    )
    .post(
      "/web/restart",
      describeRoute({
        summary: "Restart web runtime",
        description:
          "Schedule a controlled web runtime restart. Intended for authenticated operators; clients should wait for health recovery and then reload. Optional `targets` body selects which layers to rebuild (daemon/frontend/gateway); when omitted, webctl.sh auto-detects dirty layers and skips unchanged ones.",
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
                    runtimeMode: z.enum(["dev-source", "dev-standalone", "service", "gateway-daemon", "unknown"]),
                    probePath: z.literal("/api/v2/global/health"),
                    recommendedInitialDelayMs: z.number(),
                    fallbackReloadAfterMs: z.number(),
                    recoveryDeadlineMs: z.number(),
                  }),
                ),
              },
            },
          },
          409: { description: "Another restart is already in progress" },
          ...errors(500),
        },
      }),
      validator(
        "json",
        z
          .object({
            targets: z.array(z.enum(["daemon", "frontend", "gateway"])).optional(),
            reason: z.string().max(500).optional(),
          })
          .partial()
          .optional(),
      ),
      async (c) => {
        const runtimeMode = resolveRestartRuntimeMode()
        const body = (c.req.valid("json" as never) as { targets?: Array<"daemon" | "frontend" | "gateway">; reason?: string } | undefined) ?? {}
        const targets = body.targets ?? []
        const wantsGateway = targets.includes("gateway")

        // Gateway daemon mode: run webctl rebuild+install first (smart-skip
        // per-layer), then self-terminate so gateway respawns the new binary.
        // safe-daemon-restart RESTART-001 v2.
        if (isGatewayDaemon()) {
          const webctlPath = resolveWebctlPath()
          const txid = `web-${Date.now()}-${process.pid}`
          const runtimeTmp = process.env.XDG_RUNTIME_DIR || "/tmp"
          const errorLogPath = path.join(runtimeTmp, `opencode-web-restart-${txid}.error.log`)

          const exists = await Bun.file(webctlPath).exists()
          if (!exists) {
            log.error("web-restart mode=gateway-daemon rejected: webctl missing", { webctlPath })
            return c.json({ code: "WEBCTL_MISSING", message: `web control script not found: ${webctlPath}` }, 500)
          }

          const cmd = [webctlPath, "restart", "--graceful"]
          if (wantsGateway) cmd.push("--force-gateway")

          log.info("web-restart mode=gateway-daemon invoking webctl", {
            txid,
            webctlPath,
            targets,
            wantsGateway,
            reason: body.reason,
          })

          const proc = Bun.spawn({
            cmd,
            stdout: "ignore",
            stderr: "pipe",
            stdin: "ignore",
            env: {
              ...process.env,
              OPENCODE_RESTART_TXID: txid,
              OPENCODE_RESTART_ERROR_LOG_FILE: errorLogPath,
            },
          })
          const stderrPromise = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("")
          const webctlExit = await proc.exited
          const stderr = (await stderrPromise).trim()

          if (webctlExit !== 0) {
            // Busy lock → 409. Other failures → 500.
            const isBusy = /already\s+in\s+progress/i.test(stderr)
            log.error("web-restart mode=gateway-daemon webctl failed", {
              webctlPath,
              webctlExit,
              txid,
              errorLogPath,
              isBusy,
              stderrHead: stderr.slice(0, 400),
            })
            return c.json(
              {
                code: isBusy ? "RESTART_LOCK_BUSY" : "WEB_RESTART_FAILED",
                message: stderr || `webctl restart failed (exit ${webctlExit})`,
                webctlExit,
                txid,
                errorLogPath,
                webctlPath,
                hint: "Current runtime is gateway-daemon mode; webctl rebuilds changed layers. See the error log for full output. System kept on previous version.",
              },
              isBusy ? 409 : 500,
            )
          }

          log.info("web-restart mode=gateway-daemon webctl ok, scheduling self-terminate", {
            txid,
            webctlExit,
          })

          // Respond first, then exit so the response reaches the client.
          setTimeout(async () => {
            const { Daemon } = await import("@/server/daemon")
            log.info("gateway-daemon self-terminating for restart", { txid })
            await Daemon.removeDiscovery().catch(() => {})
            process.exit(0)
          }, 300)

          return c.json({
            ok: true,
            accepted: true,
            mode: "controlled_restart",
            runtimeMode: "gateway-daemon",
            probePath: "/api/v2/global/health",
            recommendedInitialDelayMs: 1000,
            fallbackReloadAfterMs: 5000,
            recoveryDeadlineMs: 30000,
          })
        }

        // Legacy mode: use webctl.sh restart
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
            runtimeMode === "dev-source" || runtimeMode === "dev-standalone"
              ? "Current runtime is dev/webctl mode; restart may include rebuild/startup delay. See restart error log for full output."
              : runtimeMode === "service"
                ? "Current runtime is service mode; check system service and restart error log for details."
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

        const recommendedInitialDelayMs = runtimeMode === "service" ? 2500 : 1500
        const fallbackReloadAfterMs = runtimeMode === "service" ? 15000 : 10000
        const recoveryDeadlineMs = runtimeMode === "service" ? 90000 : 70000

        return c.json({
          ok: true,
          accepted: true,
          mode: "controlled_restart",
          runtimeMode,
          probePath: "/api/v2/global/health",
          txid,
          recommendedInitialDelayMs,
          fallbackReloadAfterMs,
          recoveryDeadlineMs,
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
        await Bus.publish(GlobalDisposedEvent, {}, { directory: "global" })
        return c.json(true)
      },
    )
    .get(
      "/log-level",
      describeRoute({
        summary: "Get log level",
        description: "Get the current Bus log level.",
        operationId: "global.logLevel.get",
        responses: {
          200: {
            description: "Current log level",
            content: {
              "application/json": {
                schema: resolver(z.object({ level: z.number(), name: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        const level = getLogLevel()
        return c.json({ level, name: LOG_LEVELS[level] })
      },
    )
    .post(
      "/log-level",
      describeRoute({
        summary: "Set log level",
        description: "Set the Bus log level dynamically. Takes effect immediately in-process.",
        operationId: "global.logLevel.set",
        responses: {
          200: {
            description: "Updated log level",
            content: {
              "application/json": {
                schema: resolver(z.object({ level: z.number(), name: z.string() })),
              },
            },
          },
        },
      }),
      validator("json", z.object({ level: z.number().int().min(0).max(3) })),
      async (c) => {
        const { level } = c.req.valid("json")
        setLogLevel(level as LogLevel)
        return c.json({ level, name: LOG_LEVELS[level as LogLevel] })
      },
    ),
)
