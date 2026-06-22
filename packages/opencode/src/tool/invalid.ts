import z from "zod"
import { Tool } from "./tool"

export const InvalidTool = Tool.define("invalid", {
  description: "Do not use",
  parameters: z.object({
    tool: z.string(),
    error: z.string(),
    // "unknown" → the tool name does not exist in this session (redirected here
    // from the repair path); retrying the same name just lands back on invalid.
    // "args" (default) → a real tool rejected the arguments; fix args and retry.
    // bug_20260622_invalid_sink_perseveration: the old single message phrased a
    // non-existent-tool error as "arguments are invalid", reading like a fixable
    // args problem, so the model retried the phantom name forever.
    kind: z.enum(["unknown", "args"]).optional(),
  }),
  async execute(params) {
    if (params.kind === "unknown") {
      return {
        title: "Invalid Tool",
        output:
          `Tool "${params.tool}" does not exist in this session — your call was redirected to the invalid sink. ${params.error}\n\n` +
          `Do NOT retry this name: calling it again just lands back here. Use a tool name from your available tools / <on-demand-tools> catalog, ` +
          `or if the capability is genuinely missing, stop and tell the user what you need instead of looping.`,
        metadata: {},
      }
    }
    return {
      title: "Invalid Tool",
      output: `The arguments provided to the tool are invalid: ${params.error}`,
      metadata: {},
    }
  },
})
