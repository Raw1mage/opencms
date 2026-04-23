/**
 * cancel_task tool (responsive-orchestrator R4)
 *
 * Lets main agent abort a single running subagent without affecting its
 * own session or other concurrent subagents. Translates the user's
 * natural-language "stop that subagent" intent into a precise per-subagent
 * abort signal.
 *
 * Returns immediately after dispatching the signal — does not wait for
 * the subagent to actually exit. The eventual `canceled` terminal finish
 * is delivered to the parent via the same disk-terminal + watchdog A +
 * pending-notice-appender pipeline that handles natural completion
 * (DD-6 single authority pattern).
 */

import z from "zod"
import { Tool } from "./tool"
import { cancelByJobId } from "./task"

export const CancelTaskTool = Tool.define("cancel_task", async () => {
  return {
    description: [
      "Cancel a single running subagent dispatched via the `task` tool.",
      "Use this when the user asks to stop, cancel, or abort a particular",
      "subagent task that is still in flight. Does NOT terminate the main",
      "session, other subagents, or your own current turn — only the one",
      "named subagent receives an abort signal.",
      "",
      "The cancellation result (a `<task_result>` style notice with",
      "status=cancelled) arrives on your next turn via the normal",
      "subagent completion pipeline. There is no need to poll.",
      "",
      "Returns:",
      "  - status='cancelled': the abort signal was sent successfully.",
      "  - status='not_found': no running subagent matches that jobId.",
      "  - status='already_terminal': the subagent finished before the",
      "    signal arrived (race; result already delivered separately).",
    ].join("\n"),
    parameters: z.object({
      jobId: z
        .string()
        .describe(
          "The jobId from the original `task` dispatch result, or equivalently the toolCallID of the dispatching task tool call. Required.",
        ),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe(
          "Optional human-readable reason for the cancellation. Echoed in the resulting cancel notice for audit (e.g. 'user changed their mind', 'requirement changed', 'taking too long').",
        ),
    }),
    async execute(params) {
      const status = cancelByJobId(params.jobId, params.reason)
      return {
        title: `cancel_task ${params.jobId}`,
        output: `cancel_task ${params.jobId}: ${status}`,
        metadata: {
          jobId: params.jobId,
          status,
          reason: params.reason,
        },
      }
    },
  }
})
