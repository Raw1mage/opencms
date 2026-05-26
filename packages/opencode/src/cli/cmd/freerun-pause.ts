/**
 * `opencode freerun-pause <sessionID>` — pause a freerun session.
 *
 * Sets meta.json `final_status: "paused"`. The engine's next iteration
 * pre-flight check + the daemon-side autonomous-loop classifier both
 * respect this immediately.
 */

import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Global } from "../../global"
import { MetaFS } from "../../freerun/storage/meta-fs"

export const FreerunPauseCommand = cmd({
  command: "freerun-pause <sessionID>",
  describe: "pause a freerun session (sets meta.final_status='paused')",
  builder: (yargs: Argv) =>
    yargs.positional("sessionID", { type: "string", demandOption: true, describe: "session id under storage/freerun/" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessionID = args.sessionID as string
      const updated = await MetaFS.patch(sessionID, Global.Path.data, { final_status: "paused" })
      if (updated === null) {
        UI.error(`session '${sessionID}' has no meta.json (was it ever started by the engine?)`)
        process.exit(2)
      }
      UI.println(`paused: ${sessionID}`)
      UI.println(`total_iterations: ${updated.total_iterations}`)
    })
  },
})
