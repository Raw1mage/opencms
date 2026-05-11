import z from "zod"

import { Memory } from "@/session/memory"
import { Log } from "@/util/log"

import { Tool } from "./tool"

const log = Log.create({ service: "tool.recall" })

const parameters = z.object({
  tool_call_id: z
    .string()
    .min(1)
    .describe(
      "The tool_call_id (e.g. call_abc123) of a prior tool call you want to retrieve. " +
        "Look up valid ids in the most recent narrative anchor's ## TOOL_INDEX section.",
    ),
})

/**
 * AI-callable recall tool (compaction/recall-affordance L2).
 *
 * Recovery channel for tool-call results that have been collapsed into a
 * narrative anchor body. When `recall(tool_call_id)` is invoked, the tool
 * scans the session's on-disk message stream for a ToolPart whose callID
 * matches and returns its original output text.
 *
 * Use cases (per spec):
 * - After rebind-triggered narrative compaction, retrieve pre-anchor tool
 *   outputs listed in the anchor body's ## TOOL_INDEX section.
 * - Verify a prior tool result that the narrative summary references but
 *   does not quote in full.
 *
 * Idempotent — repeated calls with the same id return identical content.
 * O(n) message scan; n bounded by session message count.
 */
export const RecallTool = Tool.define("recall", {
  description:
    "RECALL / RETRIEVE the original full output of a prior tool call by its tool_call_id. " +
    "Use this when your tool history has been narrative-compacted (you will see an explicit COMPACTION NOTICE in your context). " +
    "The narrative anchor's `## TOOL_INDEX` section lists every recallable tool_call_id with its tool name, args summary, and output size — pick ids from there. " +
    "If you need to verify or act on a prior tool result, prefer this recall over assuming the narrative prose is sufficient. " +
    "Returns the original tool output text, or a typed error if the id is unknown (in which case re-execute the original tool).",
  parameters,
  async execute(
    params,
    ctx,
  ): Promise<{
    title: string
    metadata: {
      error?: "unknown_call_id"
      resolvedCallID?: string
      originalToolName?: string
      redundant?: boolean
      outputChars?: number
    }
    output: string
  }> {
    const callID = params.tool_call_id
    const hit = await Memory.Hybrid.recallByCallId(ctx.sessionID, callID)

    if (!hit) {
      log.info("recall.unknown_call_id", { sessionID: ctx.sessionID, callID })
      return {
        title: callID,
        metadata: { error: "unknown_call_id" },
        output:
          `Tool call '${callID}' not found in this session's history. ` +
          `Possible causes: the id was misread from the narrative anchor's TOOL_INDEX, ` +
          `the call originated in a subagent stream (use read_subsession instead), ` +
          `or the index entry was truncated. ` +
          `Recommended action: re-execute the original tool (the tool name listed in TOOL_INDEX) with the same arguments.`,
      }
    }

    const { toolPart, message } = hit

    // Redundancy: a ToolPart whose containing message is after the most-recent
    // narrative anchor is still in live journal — the model already has its
    // content in the prompt. Recall still succeeds (idempotent) but flags the
    // redundancy for telemetry.
    const anchor = await Memory.Hybrid.getAnchorMessage(ctx.sessionID).catch(() => null)
    const redundant =
      anchor !== null &&
      message.info?.id !== undefined &&
      anchor.info?.id !== undefined &&
      message.info.id > anchor.info.id

    let outputText: string
    let outputChars = 0
    if (toolPart.state.status === "completed") {
      outputText = toolPart.state.output ?? ""
      outputChars = outputText.length
    } else if (toolPart.state.status === "error") {
      outputText =
        `Tool call '${callID}' (${toolPart.tool}) ended in error state. ` +
        `Original error: ${toolPart.state.error}`
      outputChars = outputText.length
    } else {
      outputText =
        `Tool call '${callID}' (${toolPart.tool}) is in '${toolPart.state.status}' state — no completed output available.`
      outputChars = outputText.length
    }

    log.info("recall.invoked", {
      sessionID: ctx.sessionID,
      callID,
      found: true,
      redundant,
      originalToolName: toolPart.tool,
      outputChars,
    })

    return {
      title: callID,
      metadata: {
        resolvedCallID: callID,
        originalToolName: toolPart.tool,
        redundant,
        outputChars,
      },
      output: outputText,
    }
  },
})
