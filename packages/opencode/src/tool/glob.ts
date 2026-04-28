import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { ToolBudget } from "./budget"
import DESCRIPTION from "./glob.txt"
import { Ripgrep } from "../file/ripgrep"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"

export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe(
        `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
      ),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "glob",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
      },
    })

    let search = params.path ?? Instance.directory
    search = path.isAbsolute(search) ? search : path.resolve(Instance.directory, search)
    await assertExternalDirectory(ctx, search, { kind: "directory" })

    const limit = 100
    const files = []
    let truncated = false
    for await (const file of Ripgrep.files({
      cwd: search,
      glob: [params.pattern],
      signal: ctx.abort,
    })) {
      if (files.length >= limit) {
        truncated = true
        break
      }
      const full = path.resolve(search, file)
      const stats = await Bun.file(full)
        .stat()
        .then((x) => x.mtime.getTime())
        .catch(() => 0)
      files.push({
        path: full,
        mtime: stats,
      })
    }
    files.sort((a, b) => b.mtime - a.mtime)

    const output = []
    if (files.length === 0) output.push("No files found")
    if (files.length > 0) {
      output.push(...files.map((f) => f.path))
      if (truncated) {
        output.push("")
        output.push(
          `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
        )
      }
    }
    let body = output.join("\n")

    // Layer 2 (specs/tool-output-chunking/, DD-2): token-aware bound.
    // The path-list cap of `limit` (100 files) covers most cases; this
    // post-hoc check activates only when individual paths are unusually
    // long or the model's context window is small. INV-8: byte-identical
    // for natural-fit cases.
    const budget = ToolBudget.resolve(ctx, "glob")
    if (ToolBudget.estimateTokens(body) > budget.tokens) {
      let kept = files.length
      while (kept > 0) {
        const head = files.slice(0, kept).map((f) => f.path).join("\n")
        const hint =
          `\n\n(Results bounded at ~${budget.tokens} tokens by Layer 2 ` +
          `(${budget.source}). Showing first ${kept} of ${files.length}+ paths. ` +
          `Use a more specific path or pattern to narrow results.)`
        const candidate = (kept === 0 ? "No files found" : head) + hint
        if (ToolBudget.estimateTokens(candidate) <= budget.tokens) {
          body = candidate
          truncated = true
          break
        }
        kept = Math.max(0, Math.floor(kept * 0.85))
      }
    }

    return {
      title: path.relative(Instance.worktree, search),
      metadata: {
        count: files.length,
        truncated,
      },
      output: body,
    }
  },
})
