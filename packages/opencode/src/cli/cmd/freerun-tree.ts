/**
 * `opencode freerun-tree <sessionID>` — dump full ContextNode tree as nested markdown.
 *
 * Unlike `freerun-status`, this prints every node's full body + state payload
 * for deep inspection. Output is parseable as a markdown document.
 */

import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Global } from "../../global"
import { Tree } from "../../freerun/storage/tree"

export const FreerunTreeCommand = cmd({
  command: "freerun-tree <sessionID>",
  describe: "print full freerun ContextNode tree as nested markdown",
  builder: (yargs: Argv) =>
    yargs.positional("sessionID", {
      type: "string",
      describe: "session id under <dataHome>/storage/freerun/",
      demandOption: true,
    }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const dataHome = Global.Path.data
      const sessionID = args.sessionID as string

      let tree: Tree.Snapshot
      try {
        tree = await Tree.load(sessionID, dataHome)
      } catch (err) {
        UI.error(`failed to load session '${sessionID}': ${err instanceof Error ? err.message : err}`)
        process.exit(2)
      }

      UI.println(`# freerun session: ${sessionID}`)
      UI.println("")
      for (const { node, depth } of Tree.walkBFS(tree)) {
        const heading = "#".repeat(Math.min(depth + 2, 6))
        UI.println(`${heading} [${node.mode}] ${node.id} — ${node.title}`)
        UI.println("")
        UI.println(`- created_at: ${node.created_at}`)
        if (node.updated_at) UI.println(`- updated_at: ${node.updated_at}`)
        UI.println(`- iteration_count: ${node.iteration_count}`)
        if (node.relevant_tools?.length) UI.println(`- relevant_tools: ${node.relevant_tools.join(", ")}`)
        if (node.relevant_skills?.length) UI.println(`- relevant_skills: ${node.relevant_skills.join(", ")}`)
        UI.println("")
        if (node.body.trim().length > 0) {
          UI.println("**body**")
          UI.println("")
          UI.println(node.body)
          UI.println("")
        }
        if (node.observations.length > 0) {
          UI.println("**observations**")
          for (const obs of node.observations) UI.println(`- ${obs}`)
          UI.println("")
        }
        if (node.decisions.length > 0) {
          UI.println("**decisions**")
          for (const d of node.decisions) {
            UI.println(`- ${d.decision} (${d.rationale})`)
          }
          UI.println("")
        }
        if (node.blockers.length > 0) {
          UI.println("**blockers**")
          for (const b of node.blockers) UI.println(`- ${b}`)
          UI.println("")
        }
        if (node.results !== null) {
          UI.println("**results**")
          UI.println("```json")
          UI.println(JSON.stringify(node.results, null, 2))
          UI.println("```")
          UI.println("")
        }
        if (node.next_intent) {
          UI.println("**next_intent**")
          UI.println("")
          UI.println(node.next_intent)
          UI.println("")
        }
        if (node.consolidated_summary) {
          UI.println("**consolidated_summary**")
          UI.println("")
          UI.println(node.consolidated_summary)
          UI.println("")
        }
      }
    })
  },
})
