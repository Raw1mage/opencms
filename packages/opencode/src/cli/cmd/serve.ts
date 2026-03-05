import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { WebAuthCredentials } from "../../server/web-auth-credentials"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    const authMode = WebAuthCredentials.mode()
    if (!WebAuthCredentials.enabled()) {
      console.log(`Warning: Web auth is not configured for mode '${authMode}'.`)
    } else if (authMode === "pam") {
      console.log("Info: Web auth enabled via PAM mode.")
    } else if (authMode === "htpasswd") {
      console.log(`Info: Web auth enabled via credential file mode (${WebAuthCredentials.filePath()}).`)
    } else if (authMode === "legacy") {
      console.log("Info: Web auth enabled via OPENCODE_SERVER_PASSWORD mode (legacy).")
    } else if (WebAuthCredentials.filePath()) {
      console.log(`Info: Web auth enabled via auto mode (credential file ${WebAuthCredentials.filePath()}).`)
    } else {
      console.log("Info: Web auth enabled via auto mode (legacy/PAM fallback).")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    await new Promise(() => {})
    await server.stop()
  },
})
