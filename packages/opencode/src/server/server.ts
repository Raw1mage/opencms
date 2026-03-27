import { Log } from "../util/log"
import { generateSpecs } from "hono-openapi"
import { Hono } from "hono"
import { lazy } from "../util/lazy"
import { websocket } from "hono/bun"
import { MDNS } from "./mdns"
import { createApp } from "./app"
import { Daemon as RuntimeDaemon } from "../daemon"
import { Daemon as DiscoveryDaemon } from "./daemon"

globalThis.AI_SDK_LOG_WARNINGS = false

export namespace Server {
  const log = Log.create({ service: "server" })

  let _url: URL | undefined
  let _corsWhitelist: string[] = []

  export function url(): URL {
    return _url ?? new URL("http://localhost:4096")
  }

  const app = new Hono()

  // Initialize app with all routes and middleware
  // Extracted to separate file to fix TypeScript type inference issues with lazy()
  export const App: () => Hono = lazy(() => {
    globalThis.__CORS_WHITELIST = _corsWhitelist
    return createApp(app)
  })

  export async function openapi() {
    // Cast to break excessive type recursion from long route chains
    const result = await generateSpecs(App() as Hono, {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  export function listen(opts: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    _corsWhitelist = opts.cors ?? []

    const args = {
      hostname: opts.hostname,
      idleTimeout: 120, // @event_20260319_daemonization Phase θ.4
      fetch: App().fetch,
      websocket: websocket,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    _url = server.url

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    return server
  }

  /**
   * Start server listening on a Unix domain socket.
   * Writes discovery file after binding.
   *
   * @event_20260319_daemonization Phase β.2 / β.3
   */
  export async function listenUnix(socketPath: string): Promise<ReturnType<typeof Bun.serve>> {
    log.info("starting unix socket daemon", { socketPath })

    // Check single-instance guard
    const existingPid = await DiscoveryDaemon.checkSingleInstance()
    if (existingPid !== null) {
      throw new Error(`opencode daemon already running (pid ${existingPid}). Use --attach to connect.`)
    }

    const lifecycleStarted = await RuntimeDaemon.start()
    if (!lifecycleStarted) {
      throw new Error("failed to start daemon lifecycle")
    }

    // Bun's TypeScript overloads for unix vs TCP are separate union types that
    // don't overlap; double-cast via unknown to satisfy the compiler.
    const server = Bun.serve({
      unix: socketPath,
      idleTimeout: 120, // @event_20260319_daemonization Phase θ.4
      fetch: App().fetch,
      websocket: websocket,
    } as unknown as Parameters<typeof Bun.serve>[0])

    _url = new URL(`http://localhost`)

    // Write discovery file so TUI and other clients can find us
    await DiscoveryDaemon.writeDiscovery({
      socketPath,
      pid: process.pid,
      startedAt: Date.now(),
      version: process.env.npm_package_version ?? "unknown",
    })

    log.info("daemon ready", { socketPath, pid: process.pid })

    let stopping = false
    const cleanup = async () => {
      if (stopping) return
      stopping = true
      log.info("daemon shutting down, removing discovery files")
      await RuntimeDaemon.shutdown().catch(() => {})
      await DiscoveryDaemon.removeDiscovery().catch(() => {})
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      await cleanup()
      return originalStop(closeActiveConnections)
    }

    process.once("exit", () => {
      DiscoveryDaemon.removeDiscovery().catch(() => {})
    })

    return server
  }
}
