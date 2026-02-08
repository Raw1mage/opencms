import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"
import { Truncate } from "./truncation"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"

const MAX_LINE_LENGTH = 2000

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    let searchPath = params.path ?? Instance.directory
    searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Instance.directory, searchPath)
    await assertExternalDirectory(ctx, searchPath, { kind: "directory" })

    const rgPath = await Ripgrep.filepath()
    const args = ["-nH", "--hidden", "--no-messages", "--field-match-separator=|", "--regexp", params.pattern]
    if (params.include) {
      args.push("--glob", params.include)
    }
    args.push(searchPath)

    const proc = Bun.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      signal: ctx.abort,
    })

    const matches: { path: string; modTime: number; lineNum: number; lineText: string }[] = []
    const limit = 10000
    let truncated = false
    let hasOutput = false

    const decoder = new TextDecoder()
    let leftover = ""

    const reader = proc.stdout.getReader()
    try {
      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break

        hasOutput = true
        const text = decoder.decode(value, { stream: true })
        const lines = (leftover + text).split(/\r?\n/)
        leftover = lines.pop() ?? ""

        for (const line of lines) {
          if (!line) continue

          const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
          if (!filePath || !lineNumStr || lineTextParts.length === 0) continue

          const lineNum = parseInt(lineNumStr, 10)
          const lineText = lineTextParts.join("|")

          const file = Bun.file(filePath)
          const stats = await file.stat().catch(() => null)
          if (!stats) continue

          matches.push({
            path: filePath,
            modTime: stats.mtime.getTime(),
            lineNum,
            lineText,
          })

          if (matches.length >= limit) {
            truncated = true
            proc.kill()
            break outer
          }
        }
      }
    } catch (e) {
      // Ignore errors from killing the process or stream issues
    }

    const errorOutput = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    // Exit codes: 0 = matches found, 1 = no matches, 2 = errors
    if (exitCode === 1 || (!hasOutput && exitCode === 2)) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    if (exitCode !== 0 && exitCode !== 2 && exitCode !== null && !truncated) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    const hasErrors = exitCode === 2

    matches.sort((a, b) => b.modTime - a.modTime)

    const finalMatches = matches // already limited by the loop

    if (finalMatches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    const outputLines = [`Found ${finalMatches.length} matches`]

    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("")
        }
        currentFile = match.path
        outputLines.push(`${match.path}:`)
      }
      const truncatedLineText =
        match.lineText.length > MAX_LINE_LENGTH ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    if (hasErrors) {
      outputLines.push("")
      outputLines.push("(Some paths were inaccessible and skipped)")
    }

    const fullOutput = outputLines.join("\n")

    // For grep, we want to be very aggressive about saving to file to keep UI clean
    // and context window efficient.
    const threshold = 1000 // characters
    if (fullOutput.length > threshold) {
      // Use Truncate logic to save file but return a specialized minimalist hint
      const result = await Truncate.output(fullOutput, { maxLines: 0 }, ctx.extra?.agent, ctx.sessionID)
      const hint = `This output is redirected to ${result.truncated ? result.outputPath : "internal error"}`

      return {
        title: params.pattern,
        metadata: {
          matches: finalMatches.length,
          truncated: true,
          ...(result.truncated && { outputPath: result.outputPath }),
        },
        output: hint,
      }
    }

    return {
      title: params.pattern,
      metadata: {
        matches: finalMatches.length,
        truncated: false,
      },
      output: fullOutput,
    }
  },
})
