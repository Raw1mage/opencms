import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { WebAuthCredentials } from "../../server/web-auth-credentials"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!WebAuthCredentials.enabled()) {
      console.log("Warning: Web auth is not configured; set OPENCODE_SERVER_HTPASSWD or OPENCODE_SERVER_PASSWORD.")
    } else if (Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Info: Web auth enabled via OPENCODE_SERVER_PASSWORD mode (legacy fallback).")
    } else if (WebAuthCredentials.filePath()) {
      console.log(`Info: Web auth enabled via credential file mode (${WebAuthCredentials.filePath()}).`)
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    await new Promise(() => {})
    await server.stop()
  },
})
