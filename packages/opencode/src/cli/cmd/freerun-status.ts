/**
 * `opencode freerun-status [sessionID]` — inspect freerun engine state.
 *
 * With no argument: lists all freerun sessions found under
 * `<dataHome>/storage/freerun/` and a one-line summary each.
 * With a sessionID: prints a tree summary (titles + modes by depth).
 */

import type { Argv } from "yargs"
import * as fs from "fs/promises"
import * as path from "path"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Global } from "../../global"
import { summarizeFreerunEvents, readFreerunEventRecords } from "../../freerun/observability/metrics"
import { renderFreerunStatusView } from "../../freerun/status-view"
import { Tree } from "../../freerun/storage/tree"
import { FreerunTodoProjection } from "../../freerun/todo-projection"
import { Todo } from "../../session/todo"
import type { NodeMode } from "../../freerun/types"

export const FreerunStatusCommand = cmd({
  command: "freerun-status [sessionID]",
  describe: "list active freerun sessions or inspect one session's tree",
  builder: (yargs: Argv) =>
    yargs.positional("sessionID", { type: "string", describe: "specific session id to inspect" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const dataHome = Global.Path.data
      const sessionID = args.sessionID as string | undefined

      if (sessionID !== undefined) {
        await showOne(sessionID, dataHome)
        return
      }
      await showAll(dataHome)
    })
  },
})

async function showAll(dataHome: string): Promise<void> {
  const root = path.join(dataHome, "storage", "freerun")
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      UI.println("(no freerun sessions yet)")
      return
    }
    throw err
  }

  if (entries.length === 0) {
    UI.println("(no freerun sessions yet)")
    return
  }

  UI.println("freerun sessions:")
  for (const id of entries.sort()) {
    try {
      const tree = await Tree.load(id, dataHome)
      const nodeCount = Tree.size(tree)
      const counts: Partial<Record<NodeMode, number>> = {}
      for (const n of Tree.walkDFS(tree)) {
        counts[n.mode] = (counts[n.mode] ?? 0) + 1
      }
      const rootNode = Tree.get(tree, tree.rootId)
      const modeBreakdown = Object.entries(counts)
        .map(([mode, count]) => `${mode}=${count}`)
        .join(" ")
      UI.println(`  ${id}`)
      UI.println(`    root: [${rootNode.mode}] ${rootNode.title}`)
      UI.println(`    nodes: ${nodeCount}  (${modeBreakdown})`)
    } catch (err) {
      UI.println(`  ${id} — (failed to load: ${err instanceof Error ? err.message : err})`)
    }
  }
}

async function showOne(sessionID: string, dataHome: string): Promise<void> {
  let tree: Tree.Snapshot
  try {
    tree = await Tree.load(sessionID, dataHome)
  } catch (err) {
    UI.error(`failed to load session '${sessionID}': ${err instanceof Error ? err.message : err}`)
    process.exit(2)
  }
  const projectedTodos = await Todo.get(sessionID).catch(() => FreerunTodoProjection.project(tree))
  const metrics = summarizeFreerunEvents(await readFreerunEventRecords(sessionID, dataHome))
  UI.println(renderFreerunStatusView({ sessionID, tree, projectedTodos, metrics }))
}
