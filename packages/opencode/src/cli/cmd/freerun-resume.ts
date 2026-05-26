/**
 * `opencode freerun-resume <sessionID>` — resume a paused freerun session.
 *
 * Flips meta.json final_status from "paused" back to "in_progress". The
 * engine resumes on the next `freerun-goal --session <sessionID>` invocation
 * or the next daemon-side autonomous tick.
 */

import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Global } from "../../global"
import { MetaFS } from "../../freerun/storage/meta-fs"

export const FreerunResumeCommand = cmd({
  command: "freerun-resume <sessionID>",
  describe: "resume a paused freerun session (sets meta.final_status='in_progress')",
  builder: (yargs: Argv) =>
    yargs.positional("sessionID", { type: "string", demandOption: true, describe: "session id under storage/freerun/" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessionID = args.sessionID as string
      const current = await MetaFS.read(sessionID, Global.Path.data)
      if (current === null) {
        UI.error(`session '${sessionID}' has no meta.json`)
        process.exit(2)
      }
      if (current.final_status !== "paused") {
        UI.println(`(noop) session '${sessionID}' is in state '${current.final_status}', not paused`)
        return
      }
      const updated = await MetaFS.patch(sessionID, Global.Path.data, { final_status: "in_progress" })
      UI.println(`resumed: ${sessionID}`)
      UI.println(`total_iterations: ${updated?.total_iterations ?? "?"}`)
    })
  },
})
