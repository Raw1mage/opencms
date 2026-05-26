/**
 * `opencode freerun-smoke` — end-to-end smoke test for the freerun engine.
 *
 * Drives a single freerun session against the provided custom-provider for
 * a small number of iterations. Use this to verify the engine works against
 * a live LLM (e.g. rawbase llama-server) without needing the full
 * workflow-runner autonomous-loop integration.
 *
 * Usage:
 *   opencode freerun-smoke \
 *     --provider custom-provider-work \
 *     --model qwen3.6-35b-a3b-q4_k_m \
 *     --goal "列出 ~/Downloads 的檔案，告訴我哪些是 .pdf" \
 *     --iterations 3
 */

import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { Engine } from "../../freerun/runtime/engine"
import { FreerunLlmClient } from "../../freerun/provider/llm-client"
import { NodeFS } from "../../freerun/storage/node-fs"
import { Tree } from "../../freerun/storage/tree"
import {
  ExperimentConfig,
  hashExperimentConfig,
  type ContextNode,
} from "../../freerun/types"

export const FreerunSmokeCommand = cmd({
  command: "freerun-smoke",
  describe: "drive the freerun engine for N iterations against a custom-provider (smoke test)",
  builder: (yargs: Argv) =>
    yargs
      .option("provider", {
        type: "string",
        demandOption: true,
        describe: "provider id from opencode.json (must have mode: freerun and options.baseURL set)",
      })
      .option("model", {
        type: "string",
        demandOption: true,
        describe: "model id (sent in request body)",
      })
      .option("goal", {
        type: "string",
        demandOption: true,
        describe: "goal text — becomes the root ContextNode.body",
      })
      .option("title", {
        type: "string",
        describe: "title for the root node (defaults to goal text)",
      })
      .option("session", {
        type: "string",
        describe: "freerun session id (defaults to freerun-smoke-<timestamp>)",
      })
      .option("iterations", {
        type: "number",
        default: 3,
        describe: "iteration cap for this drive (default 3)",
      })
      .option("dataHome", {
        type: "string",
        describe: "override Global.Path.data for storage (testing)",
      })
      .option("no-tools", {
        type: "boolean",
        default: false,
        describe: "drive engine without any tool catalog (think-only execution mode)",
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const sessionId = args.session ?? `freerun-smoke-${Date.now()}`
      const dataHome = args.dataHome ?? Global.Path.data

      // Look up provider config.
      const cfg = await Config.get()
      const providerCfg = (cfg.provider as Record<
        string,
        { mode?: "full" | "lite" | "freerun"; options?: { baseURL?: string; apiKey?: string } }
      > | undefined)?.[args.provider]
      if (!providerCfg) {
        UI.error(`provider '${args.provider}' not found in opencode.json`)
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

      UI.println(`session: ${sessionId}`)
      UI.println(`provider: ${args.provider}  model: ${args.model}`)
      UI.println(`baseURL: ${providerCfg.options.baseURL}`)
      UI.println(`iterations cap: ${args.iterations}`)
      UI.println(`goal: ${args.goal}`)
      UI.println("")

      // Seed root ContextNode (idempotent — only seeds if no root exists).
      const ids = await NodeFS.list(sessionId, dataHome).catch(() => [] as string[])
      if (ids.length === 0) {
        const root: ContextNode = {
          id: "root",
          parent_id: null,
          children_ids: [],
          title: args.title ?? args.goal.slice(0, 80),
          body: args.goal,
          mode: "pending-plan",
          created_at: new Date().toISOString(),
          iteration_count: 0,
          observations: [],
          decisions: [],
          blockers: [],
          results: null,
          next_intent: "",
          consolidated_summary: null,
        }
        await NodeFS.write(sessionId, root, dataHome)
        UI.println("  ✓ seeded root ContextNode")
      } else {
        UI.println(`  ↻ resuming existing session (${ids.length} nodes on disk)`)
      }

      const expCfg = ExperimentConfig.parse({})
      const client = FreerunLlmClient.create({
        baseUrl: providerCfg.options.baseURL,
        modelId: args.model,
        apiKey: providerCfg.options.apiKey,
        sessionId: sessionId,
        // v1 smoke: no tool dispatcher → execution rounds run think-only.
        // When workflow-runner integration lands, opencode's real tool dispatch
        // will plug in here.
        toolDispatcher: undefined,
      })

      UI.println("")
      UI.println("=== driving engine ===")
      const summary = await Engine.run({
        sessionId,
        dataHome,
        config: expCfg,
        llm: client,
        toolCatalog: args["no-tools"] ? [] : [],
        providerId: args.provider,
        userId: process.env.USER ?? "unknown",
        triggerMode: "goal",
        rootNodeId: "root",
        experimentConfigId: hashExperimentConfig(expCfg),
        iterationCapOverride: args.iterations,
      })
      UI.println(`finalStatus: ${summary.finalStatus}`)
      UI.println(`totalIterations: ${summary.totalIterations}`)
      if (summary.blockedNodeIds.length > 0) {
        UI.println(`blockedNodeIds: ${summary.blockedNodeIds.join(", ")}`)
      }
      UI.println("")

      // Dump final tree as nested markdown for inspection.
      const tree = await Tree.load(sessionId, dataHome).catch(() => null)
      if (tree !== null) {
        UI.println("=== final tree ===")
        for (const { node, depth } of Tree.walkBFS(tree)) {
          const indent = "  ".repeat(depth)
          UI.println(`${indent}- [${node.mode}] ${node.id} — ${node.title}`)
          if (node.consolidated_summary) {
            UI.println(`${indent}  summary: ${node.consolidated_summary.slice(0, 120)}`)
          }
        }
      }

      UI.println("")
      UI.println(`storage: ${dataHome}/storage/freerun/${sessionId}/tree/`)
    })
  },
})
