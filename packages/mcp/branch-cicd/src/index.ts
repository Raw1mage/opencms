#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  runMerge,
  runNewBeta,
  runSyncBack,
  type MergeInput,
  type NewBetaInput,
  type SyncBackInput,
} from "./beta-tool.js"

const server = new McpServer({
  name: "beta-tool",
  version: "0.1.0",
})

const runtimePolicySchema = z
  .object({
    kind: z.enum(["custom", "manual"]),
    startCommand: z.array(z.string()).optional(),
    refreshCommand: z.array(z.string()).optional(),
    label: z.string().optional(),
  })
  .strict()

const baseInputSchema = {
  repoRoot: z.string().optional().describe("Absolute canonical repo root."),
  mainWorktreePath: z.string().optional().describe("Absolute path to the main worktree."),
  baseBranch: z.string().optional().describe("Explicit authoritative base branch."),
  betaRoot: z.string().optional().describe("Absolute beta worktree root directory."),
  runtimePolicy: runtimePolicySchema.optional(),
}

function toolResponse(result: Awaited<ReturnType<typeof runNewBeta | typeof runSyncBack | typeof runMerge>>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: result.status === "blocked",
  }
}

server.registerTool(
  "newbeta",
  {
    title: "Create Or Reuse Beta Worktree Loop",
    description:
      "Create or reuse a feature branch beta worktree for a project-aware local loop. Fails fast on dirty trees, path conflicts, and unresolved ambiguity. When bounded choices are required, returns a structured orchestrator question contract instead of guessing.",
    inputSchema: z
      .object({
        ...baseInputSchema,
        branchName: z.string().optional().describe("Explicit feature branch name."),
        taskHint: z.string().optional().describe("Short task hint used only to propose bounded branch-name options."),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (input: NewBetaInput) => toolResponse(await runNewBeta(input)),
)

server.registerTool(
  "syncback",
  {
    title: "Sync Feature Branch Back To Main Worktree",
    description:
      "Check out the feature branch in the main worktree and optionally execute the resolved project runtime policy. Fails fast on dirty trees and missing branch mapping.",
    inputSchema: z
      .object({
        ...baseInputSchema,
        branchName: z.string().optional().describe("Feature branch name; required unless a stored loop exists."),
        runtimeMode: z.enum(["start", "refresh"]).optional(),
        executeRuntime: z.boolean().optional(),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (input: SyncBackInput) => toolResponse(await runSyncBack(input)),
)

server.registerTool(
  "merge",
  {
    title: "Merge Verified Feature Branch",
    description:
      "Merge the verified feature branch into the resolved target branch only after explicit confirmation. This tool surfaces the resolved target branch and returns a structured confirmation contract before destructive work.",
    inputSchema: z
      .object({
        ...baseInputSchema,
        branchName: z.string().optional().describe("Feature branch name; required unless a stored loop exists."),
        mergeTarget: z.string().optional().describe("Explicit merge target branch."),
        confirm: z.boolean().optional().describe("Must be true to execute merge/cleanup."),
        cleanup: z
          .object({
            removeWorktree: z.boolean().optional(),
            deleteBranch: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (input: MergeInput) => toolResponse(await runMerge(input)),
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("beta-tool running on stdio")
}

main().catch((error) => {
  console.error("beta-tool failed:", error)
  process.exit(1)
})
