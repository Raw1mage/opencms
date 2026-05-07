import { Server } from "../../server/server"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { DaemonStartupLog } from "../../server/daemon-startup-log"
import { WebAuthCredentials } from "../../server/web-auth-credentials"
import open from "open"
import { networkInterfaces } from "os"

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

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = cmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start opencode server and open web interface",
  handler: async (args) => {
    const launchMode = process.env.OPENCODE_LAUNCH_MODE
    const isGatewayChild = process.env.OPENCODE_USER_DAEMON_MODE === "1"
    if (launchMode !== "webctl" && launchMode !== "systemd" && !isGatewayChild) {
      UI.println(
        UI.Style.TEXT_WARNING_BOLD +
          "x  " +
          "Direct `opencode web` launch is disabled in this repo. Use `./webctl.sh dev-start` or `./webctl.sh web-start`.",
      )
      process.exit(1)
    }

    const disableBrowserOpen = process.env.OPENCODE_WEB_NO_OPEN === "1" || process.env.OPENCODE_WEB_NO_OPEN === "true"
    const authMode = WebAuthCredentials.mode()
    if (!WebAuthCredentials.enabled()) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  " + `Web auth is not configured for mode '${authMode}'.`)
    } else if (authMode === "pam") {
      UI.println(UI.Style.TEXT_INFO_BOLD + "i  " + "Web auth: PAM mode")
    } else if (authMode === "htpasswd") {
      UI.println(UI.Style.TEXT_INFO_BOLD + "i  " + `Web auth: credential file mode (${WebAuthCredentials.filePath()})`)
    } else if (authMode === "legacy") {
      UI.println(UI.Style.TEXT_INFO_BOLD + "i  " + "Web auth: OPENCODE_SERVER_PASSWORD mode (legacy)")
    } else if (WebAuthCredentials.filePath()) {
      UI.println(
        UI.Style.TEXT_INFO_BOLD + "i  " + `Web auth: auto mode (credential file ${WebAuthCredentials.filePath()})`,
      )
    } else {
      UI.println(UI.Style.TEXT_INFO_BOLD + "i  " + "Web auth: auto mode (legacy/PAM fallback)")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    await DaemonStartupLog.record({ port: server.port, hostname: opts.hostname })
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${server.port}`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
      }

      // Optionally open localhost in browser (disabled for managed daemon mode)
      if (!disableBrowserOpen) {
        open(localhostUrl.toString()).catch(() => {})
      }
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      if (!disableBrowserOpen) {
        open(displayUrl).catch(() => {})
      }
    }

    await waitForShutdownSignal()
    await server.stop(true)
  },
})
