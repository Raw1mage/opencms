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
  autostart?: boolean
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

async function writeRegistry(registry: Registry): Promise<void> {
  await fs.writeFile(registryPath(), JSON.stringify(registry, null, 2) + "\n", "utf-8")
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

/**
 * Run a webctl.sh action.
 *
 * For "start", we launch via `systemd-run --user --scope` so the spawned
 * service lives in its own cgroup scope, independent of the daemon unit.
 * Without this, systemd's default KillMode=control-group kills all web
 * services when the daemon unit restarts.
 *
 * "stop" and other actions run directly (they just send signals/teardown).
 */
function runWebctl(webctlPath: string, action: string, timeoutMs = 30000): Promise<{ ok: boolean; output: string }> {
  const scopeName = path.basename(path.dirname(webctlPath)).replace(/[^a-zA-Z0-9_-]/g, "_")
  const unitName = `webctl-${scopeName}.scope`

  const doSpawn = (): Promise<{ ok: boolean; output: string }> =>
    new Promise((resolve) => {
      const useScope = action === "start"
      const cmd = useScope ? "systemd-run" : "bash"
      const args = useScope
        ? ["--user", "--scope", `--unit=webctl-${scopeName}`, "--", "bash", webctlPath, action]
        : [webctlPath, action]

      const child = spawn(cmd, args, {
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
        // If systemd-run is not available, fall back to direct execution
        if (useScope && err.message.includes("ENOENT")) {
          log.warn("systemd-run not available, falling back to direct spawn", { entry: scopeName })
          const fallback = spawn("bash", [webctlPath, action], {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: timeoutMs,
          })
          let fbOut = ""
          fallback.stdout.on("data", (d: Buffer) => { fbOut += d.toString() })
          fallback.stderr.on("data", (d: Buffer) => { fbOut += d.toString() })
          fallback.on("close", (code) => resolve({ ok: code === 0, output: fbOut.trim() }))
          fallback.on("error", (e) => resolve({ ok: false, output: e.message }))
        } else {
          resolve({ ok: false, output: err.message })
        }
      })
    })

  // On start, clear any stale scope unit before spawning a new one
  if (action !== "start") return doSpawn()

  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    const reset = spawn("systemctl", ["--user", "reset-failed", unitName], {
      stdio: "ignore",
      timeout: 5000,
    })
    reset.on("close", () => {
      const stop = spawn("systemctl", ["--user", "stop", unitName], {
        stdio: "ignore",
        timeout: 5000,
      })
      stop.on("close", () => doSpawn().then(resolve))
      stop.on("error", () => doSpawn().then(resolve))
    })
    reset.on("error", () => doSpawn().then(resolve))
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

/**
 * Auto-start services marked with autostart: true in web_registry.json.
 * Called during daemon boot — runs in background, never throws.
 */
export async function autoStartServices(): Promise<void> {
  let registry: Registry
  try {
    registry = await readRegistry()
  } catch {
    log.info("no web_registry.json found, skipping auto-start")
    return
  }

  const targets = registry.entries.filter((e) => e.enabled && e.autostart)
  if (targets.length === 0) return

  log.info("auto-starting web services", { count: targets.length, names: targets.map((e) => e.entryName) })

  await Promise.allSettled(
    targets.map(async (entry) => {
      // Skip if already alive
      const alive = await tcpProbe(entry.host, entry.primaryPort)
      if (alive) {
        log.info("service already running, skipping", { entry: entry.entryName })
        return
      }

      try {
        await fs.access(entry.webctlPath)
      } catch {
        log.warn("webctl.sh not found, skipping", { entry: entry.entryName, path: entry.webctlPath })
        return
      }

      const result = await runWebctl(entry.webctlPath, "start")
      if (result.ok) {
        log.info("auto-started service", { entry: entry.entryName })
      } else {
        log.warn("auto-start failed", { entry: entry.entryName, output: result.output })
      }
    }),
  )
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

          // Persist autostart state: start → autostart: true, stop → autostart: false
          entry.autostart = body.action === "start"
          writeRegistry(registry).catch((err) =>
            log.warn("failed to persist autostart flag", { error: err instanceof Error ? err.message : String(err) }),
          )

          return c.json({ ok: result.ok, output: result.output })
        } catch (err) {
          log.warn("toggle failed", { error: err instanceof Error ? err.message : String(err) })
          return c.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, 502)
        }
      },
    ),
)
