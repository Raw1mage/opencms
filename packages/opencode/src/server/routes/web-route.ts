import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import net from "node:net"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"

const log = Log.create({ service: "web-route" })

const CTL_SOCK_PATH = "/run/opencode-gateway/ctl.sock"

const WebRouteSchema = z.object({
  prefix: z.string(),
  host: z.string(),
  port: z.number(),
  uid: z.number(),
})

type WebRoute = z.infer<typeof WebRouteSchema>

/* ── Registry types ── */

interface RegistryEntry {
  entryName: string
  projectRoot: string
  publicBasePath: string
  host: string
  primaryPort: number
  webctlPath: string
  enabled: boolean
  access: string
}

interface Registry {
  version: number
  entries: RegistryEntry[]
}

function registryPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  return path.join(xdg, "web_registry.json")
}

async function readRegistry(): Promise<Registry> {
  const raw = await fs.readFile(registryPath(), "utf-8")
  return JSON.parse(raw) as Registry
}

/* ── Health probe ── */

function tcpProbe(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port })
    sock.setTimeout(timeoutMs)
    sock.on("connect", () => {
      sock.destroy()
      resolve(true)
    })
    sock.on("error", () => {
      sock.destroy()
      resolve(false)
    })
    sock.on("timeout", () => {
      sock.destroy()
      resolve(false)
    })
  })
}

/* ── webctl.sh runner ── */

function runWebctl(webctlPath: string, action: string, timeoutMs = 30000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [webctlPath, action], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    })
    let out = ""
    child.stdout.on("data", (d: Buffer) => { out += d.toString() })
    child.stderr.on("data", (d: Buffer) => { out += d.toString() })
    child.on("close", (code) => {
      resolve({ ok: code === 0, output: out.trim() })
    })
    child.on("error", (err) => {
      resolve({ ok: false, output: err.message })
    })
  })
}

/**
 * Send a JSON command to the gateway ctl.sock and read the response.
 */
function ctlRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(CTL_SOCK_PATH)
    let data = ""

    sock.setTimeout(3000)
    sock.on("connect", () => {
      sock.write(JSON.stringify(payload) + "\n")
    })
    sock.on("data", (chunk) => {
      data += chunk.toString()
      // Protocol is newline-delimited JSON; one response per request
      if (data.includes("\n")) {
        try {
          resolve(JSON.parse(data.trim()))
        } catch {
          resolve({ ok: false, error: "invalid JSON from gateway" })
        }
        sock.destroy()
      }
    })
    sock.on("end", () => {
      if (data) {
        try {
          resolve(JSON.parse(data.trim()))
        } catch {
          resolve({ ok: false, error: "invalid JSON from gateway" })
        }
      } else {
        resolve({ ok: false, error: "empty response from gateway" })
      }
    })
    sock.on("error", (err) => {
      log.warn("ctl.sock connection failed", { error: err.message })
      reject(new Error(`gateway unreachable: ${err.message}`))
    })
    sock.on("timeout", () => {
      sock.destroy()
      reject(new Error("gateway ctl.sock timeout"))
    })
  })
}

export const WebRouteRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List web routes",
        description: "List all published web routes for the current user.",
        operationId: "webRoute.list",
        responses: {
          200: {
            description: "List of web routes",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), routes: z.array(WebRouteSchema) })),
              },
            },
          },
        },
      }),
      async (c) => {
        try {
          const result = await ctlRequest({ action: "list" })
          const routes = Array.isArray(result.routes) ? result.routes as WebRoute[] : []
          // Filter by current process UID (the per-user daemon runs as that user)
          const myUid = process.getuid?.() ?? -1
          const filtered = routes.filter((r) => r.uid === myUid)
          return c.json({ ok: true, routes: filtered })
        } catch (err) {
          log.warn("failed to list web routes", { error: err instanceof Error ? err.message : String(err) })
          return c.json({ ok: false, routes: [], error: err instanceof Error ? err.message : "unknown" }, 502)
        }
      },
    )
    .post(
      "/publish",
      describeRoute({
        summary: "Publish a web route",
        description: "Register a new public web route via the gateway.",
        operationId: "webRoute.publish",
        responses: {
          200: {
            description: "Publish result",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), error: z.string().optional() })),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          prefix: z.string().min(1),
          host: z.string().default("127.0.0.1"),
          port: z.number().int().min(1).max(65535),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json" as never) as { prefix: string; host: string; port: number }
        try {
          const result = await ctlRequest({
            action: "publish",
            prefix: body.prefix,
            host: body.host,
            port: body.port,
          })
          return c.json(result)
        } catch (err) {
          return c.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, 502)
        }
      },
    )
    .post(
      "/remove",
      describeRoute({
        summary: "Remove a web route",
        description: "Unregister a published web route.",
        operationId: "webRoute.remove",
        responses: {
          200: {
            description: "Remove result",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), error: z.string().optional() })),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          prefix: z.string().min(1),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json" as never) as { prefix: string }
        try {
          const result = await ctlRequest({
            action: "remove",
            prefix: body.prefix,
          })
          return c.json(result)
        } catch (err) {
          return c.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, 502)
        }
      },
    )
    .get(
      "/health",
      describeRoute({
        summary: "Health-check all registered web services",
        description: "TCP-probes each entry in web_registry.json and returns alive/dead status.",
        operationId: "webRoute.health",
        responses: {
          200: {
            description: "Health status map",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.boolean(),
                    status: z.record(
                      z.string(),
                      z.object({ alive: z.boolean(), host: z.string(), port: z.number(), webctlPath: z.string() }),
                    ),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        try {
          const registry = await readRegistry()
          const results: Record<string, { alive: boolean; host: string; port: number; webctlPath: string }> = {}
          await Promise.all(
            registry.entries
              .filter((e) => e.enabled)
              .map(async (entry) => {
                const alive = await tcpProbe(entry.host, entry.primaryPort)
                results[entry.entryName] = {
                  alive,
                  host: entry.host,
                  port: entry.primaryPort,
                  webctlPath: entry.webctlPath,
                }
              }),
          )
          return c.json({ ok: true, status: results })
        } catch (err) {
          log.warn("health check failed", { error: err instanceof Error ? err.message : String(err) })
          return c.json({ ok: false, status: {}, error: err instanceof Error ? err.message : "unknown" }, 502)
        }
      },
    )
    .post(
      "/toggle",
      describeRoute({
        summary: "Start or stop a registered web service",
        description: "Invokes the service's webctl.sh with start or stop.",
        operationId: "webRoute.toggle",
        responses: {
          200: {
            description: "Toggle result",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), output: z.string().optional(), error: z.string().optional() })),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          entryName: z.string().min(1),
          action: z.enum(["start", "stop"]),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json" as never) as { entryName: string; action: "start" | "stop" }
        try {
          const registry = await readRegistry()
          const entry = registry.entries.find((e) => e.entryName === body.entryName)
          if (!entry) {
            return c.json({ ok: false, error: `entry "${body.entryName}" not found in registry` }, 404)
          }

          // Verify webctl.sh exists
          try {
            await fs.access(entry.webctlPath)
          } catch {
            return c.json({ ok: false, error: `webctl.sh not found at ${entry.webctlPath}` }, 404)
          }

          log.info("toggling web service", { entry: body.entryName, action: body.action })
          const result = await runWebctl(entry.webctlPath, body.action)

          if (!result.ok) {
            log.warn("webctl.sh failed", { entry: body.entryName, action: body.action, output: result.output })
          }

          return c.json({ ok: result.ok, output: result.output })
        } catch (err) {
          log.warn("toggle failed", { error: err instanceof Error ? err.message : String(err) })
          return c.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, 502)
        }
      },
    ),
)
