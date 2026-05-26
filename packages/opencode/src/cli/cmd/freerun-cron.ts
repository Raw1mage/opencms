/**
 * `opencode freerun-cron <taskFile>` — cron-invoked freerun trigger.
 *
 * Reads a JSON task definition file (see CronTrigger.TaskDef schema) and
 * drives one freerun session. Meant to be invoked from an OS crontab line.
 */

import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { CronTrigger } from "../../freerun/trigger/cron"

export const FreerunCronCommand = cmd({
  command: "freerun-cron <taskFile>",
  describe: "drive a freerun session per the JSON task definition (for OS cron)",
  builder: (yargs: Argv) =>
    yargs.positional("taskFile", {
      type: "string",
      describe: "path to the JSON task definition file",
      demandOption: true,
    }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      try {
        const result = await CronTrigger.runFromTaskFile(args.taskFile as string)
        UI.println(`sessionId: ${result.sessionId}`)
        UI.println(`wasResumed: ${result.wasResumed}`)
        UI.println(`finalStatus: ${result.finalStatus}`)
        UI.println(`totalIterations: ${result.totalIterations}`)
      } catch (err) {
        UI.error(`freerun-cron failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })
  },
})
