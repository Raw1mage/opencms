/**
 * `opencode freerun-goal` — start (or resume) a freerun session from a goal string.
 *
 * Differs from `freerun-smoke` in that this is meant as the production entry:
 * verbose output trimmed, returns session id on stdout for scripting.
 */

import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { GoalTrigger } from "../../freerun/trigger/goal"
import { OpencodeToolBridge } from "../../freerun/provider/opencode-tool-bridge"
import { Tree } from "../../freerun/storage/tree"

export const FreerunGoalCommand = cmd({
  command: "freerun-goal",
  describe: "start or resume a freerun session from a goal string",
  builder: (yargs: Argv) =>
    yargs
      .option("provider", { type: "string", demandOption: true, describe: "provider id (must be freerun-mode)" })
      .option("model", { type: "string", demandOption: true, describe: "model id" })
      .option("goal", { type: "string", demandOption: true, describe: "goal text — becomes root.body" })
      .option("title", { type: "string", describe: "title for the root node" })
      .option("session", {
        type: "string",
        describe: "session id (defaults to freerun-<timestamp>)",
      })
      .option("iterations", { type: "number", default: 20, describe: "iteration cap" })
      .option("quiet", { type: "boolean", default: false, describe: "print only the session id on success" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessionId = args.session ?? `freerun-${Date.now()}`

      const cfg = await Config.get()
      const providerCfg = (cfg.provider as Record<
        string,
        { mode?: "full" | "lite" | "freerun"; options?: { baseURL?: string; apiKey?: string } }
      > | undefined)?.[args.provider]
      if (!providerCfg) {
        UI.error(`provider '${args.provider}' not in opencode.json`)
        process.exit(2)
      }
      if (providerCfg.mode !== "freerun") {
        UI.error(`provider '${args.provider}' has mode='${providerCfg.mode ?? "(unset)"}'; must be 'freerun'`)
        process.exit(2)
      }
      if (!providerCfg.options?.baseURL) {
        UI.error(`provider '${args.provider}' has no options.baseURL`)
        process.exit(2)
      }

      const toolCatalog = await OpencodeToolBridge.buildCatalog()
      const toolDispatcher = OpencodeToolBridge.buildDispatcher({ sessionID: sessionId })

      const result = await GoalTrigger.start({
        sessionId,
        dataHome: Global.Path.data,
        goal: args.goal,
        title: args.title,
        providerId: args.provider,
        modelId: args.model,
        baseUrl: providerCfg.options.baseURL,
        apiKey: providerCfg.options.apiKey,
        userId: process.env.USER ?? "unknown",
        iterationCapOverride: args.iterations,
        toolCatalog,
        toolDispatcher,
      })

      if (args.quiet) {
        UI.println(sessionId)
        return
      }

      UI.println(`sessionId: ${result.sessionId}`)
      UI.println(`wasResumed: ${result.wasResumed}`)
      UI.println(`finalStatus: ${result.finalStatus}`)
      UI.println(`totalIterations: ${result.totalIterations}`)
      if (result.blockedNodeIds.length > 0) {
        UI.println(`blockedNodeIds: ${result.blockedNodeIds.join(", ")}`)
      }

      // Brief tree summary.
      const tree = await Tree.load(result.sessionId, Global.Path.data).catch(() => null)
      if (tree !== null) {
        UI.println("")
        UI.println("tree:")
        for (const { node, depth } of Tree.walkBFS(tree)) {
          const indent = "  ".repeat(depth)
          UI.println(`${indent}- [${node.mode}] ${node.id} — ${node.title}`)
        }
      }
    })
  },
})
