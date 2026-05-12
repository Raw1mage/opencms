import z from "zod"
import { Tool } from "./tool"

const DESCRIPTION = "__TOOL__ tool description"

export const __CONST__ = Tool.define("__TOOL__", {
  description: DESCRIPTION,
  parameters: z.object({
    input: z.string().describe("Input text"),
  }),
  async execute(params) {
    const output = `__TOOL__: ${params.input}`
    return {
      title: "__TOOL__",
      output,
      metadata: {},
    }
  },
})
