import { Server } from "../../server/server"
import { Daemon } from "../../server/daemon"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { WebAuthCredentials } from "../../server/web-auth-credentials"
import { DaemonStartupLog } from "../../server/daemon-startup-log"
import { assertMigrationApplied } from "../../server/migration-boot-guard"
import { MigrationRequiredError } from "../../provider/registry-shape"

async function waitForShutdownSignal() {
  let keepAlive: ReturnType<typeof setInterval> | undefined
  try {
    keepAlive = setInterval(() => {}, 1 << 30)
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        process.off("SIGINT", onSignal)
        process.off("SIGTERM", onSignal)
        resolve()
      }
      const onSignal = () => cleanup()
      process.on("SIGINT", onSignal)
      process.on("SIGTERM", onSignal)
    })
  } finally {
    if (keepAlive) clearInterval(keepAlive)
  }
}

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("unix-socket", {
      type: "string",
      describe: "listen on a Unix domain socket path instead of TCP (daemon mode)",
    }),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    // @spec specs/provider-account-decoupling DD-6 — daemon boot guard.
    // Refuse to start if the storage migration hasn't run for this binary.
    // Exits 1 with a remediation hint per AGENTS.md rule 1 (no silent fallback).
    try {
      await assertMigrationApplied()
    } catch (e) {
      if (MigrationRequiredError.isInstance(e)) {
        const data = (e as any).data as { message: string }
        console.error(`error: ${data.message}`)
        process.exit(1)
      }
      throw e
    }

    // Unix socket (daemon) mode — bypass TCP + auth config
    if (args["unix-socket"]) {
      const socketPath = args["unix-socket"]
      console.log(`opencode daemon starting on unix:${socketPath}`)
      const server = await Server.listenUnix(socketPath)
      const metricsServer = Server.listenMetrics()
      await DaemonStartupLog.record({ socketPath })
      console.log(`opencode daemon ready (pid ${process.pid})`)
      await waitForShutdownSignal()
      await metricsServer?.stop(true)
      await server.stop(true)
      return
    }

    // TCP mode (existing behaviour)
    if (!WebAuthCredentials.enabled()) {
      console.log("Warning: Web auth is not enabled (non-Linux or daemon mode).")
    } else {
      console.log("Info: Web auth enabled via PAM.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    await DaemonStartupLog.record({ port: server.port, hostname: server.hostname })
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    await waitForShutdownSignal()
    await server.stop(true)
  },
})
