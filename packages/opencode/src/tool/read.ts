import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { createInterface } from "readline"
import { Tool } from "./tool"
import { ToolBudget } from "./budget"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The path to the file to read"),
    offset: z.coerce.number().describe("The line number to start reading from (0-based)").optional(),
    limit: z.coerce.number().describe("The number of lines to read (defaults to 2000)").optional(),
  }),
  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.resolve(Instance.directory, filepath)
    }
    const title = path.relative(Instance.worktree, filepath)

    const file = Bun.file(filepath)
    const stat = await file.stat().catch(() => undefined)

    await assertExternalDirectory(ctx, filepath, {
      bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
      kind: stat?.isDirectory() ? "directory" : "file",
    })

    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      always: ["*"],
      metadata: {},
    })

    if (!stat) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const dirExists = fs.existsSync(dir)

      if (!dirExists) {
        const matches: string[] = []
        try {
          const glob = new Bun.Glob(`**/${base}`)
          for await (const item of glob.scan({ cwd: Instance.worktree, onlyFiles: true })) {
            matches.push(path.join(Instance.worktree, item))
            if (matches.length >= 3) break
          }
        } catch (err: any) {
          if (err?.code !== "EACCES" && err?.code !== "EPERM") throw err
        }
        if (matches.length > 0) {
          throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${matches.join("\n")}`)
        }
        throw new Error(`File not found: ${filepath}`)
      }

      const dirEntries = fs.readdirSync(dir)
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    }

    if (stat.isDirectory()) {
      const dirents = await fs.promises.readdir(filepath, { withFileTypes: true })
      const entries = await Promise.all(
        dirents.map(async (dirent) => {
          if (dirent.isDirectory()) return dirent.name + "/"
          if (dirent.isSymbolicLink()) {
            const target = await fs.promises.stat(path.join(filepath, dirent.name)).catch(() => undefined)
            if (target?.isDirectory()) return dirent.name + "/"
          }
          return dirent.name
        }),
      )
      entries.sort((a, b) => a.localeCompare(b))

      const limit = params.limit ?? DEFAULT_READ_LIMIT
      const offset = params.offset || 0
      const slice = entries.slice(offset, offset + limit)
      const hasMoreEntries = offset + slice.length < entries.length

      let output = "<directory>\n"
      output += slice.join("\n")
      if (hasMoreEntries) {
        output += `\n\n(Directory has more entries. Use 'offset' parameter to read beyond entry ${offset + slice.length})`
      } else {
        output += `\n\n(End of directory - total ${entries.length} entries)`
      }
      output += "\n</directory>"

      return {
        title,
        output,
        metadata: {
          preview: slice.slice(0, 20).join("\n"),
          truncated: hasMoreEntries,
        },
      }
    }

    // Exclude SVG (XML-based) and vnd.fastbidsheet (.fbs extension, commonly FlatBuffers schema files)
    const isImage =
      file.type.startsWith("image/") && file.type !== "image/svg+xml" && file.type !== "image/vnd.fastbidsheet"
    const isPdf = file.type === "application/pdf"
    if (isImage || isPdf) {
      const mime = file.type
      const msg = `${isImage ? "Image" : "PDF"} read successfully`
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
          truncated: false,
        },
        attachments: [
          {
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(await file.bytes()).toString("base64")}`,
          },
        ],
      }
    }

    const isBinary = await isBinaryFile(filepath, stat.size)
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0
    const stream = fs.createReadStream(filepath, { encoding: "utf8" })
    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    })

    const raw: string[] = []
    let bytes = 0
    let totalLines = 0
    let hasMoreLines = false
    let truncatedByBytes = false
    try {
      for await (const text of rl) {
        totalLines += 1
        if (totalLines <= offset) continue

        if (raw.length >= limit) {
          hasMoreLines = true
          continue
        }

        const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
        const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
        if (bytes + size > MAX_BYTES) {
          truncatedByBytes = true
          hasMoreLines = true
          break
        }

        raw.push(line)
        bytes += size
      }
    } finally {
      rl.close()
      stream.destroy()
    }

    const content = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    let output = "<file>\n"
    output += content.join("\n")

    const lastReadLine = offset + raw.length
    hasMoreLines = hasMoreLines || totalLines > lastReadLine
    const truncated = hasMoreLines || truncatedByBytes

    if (truncatedByBytes) {
      output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += "\n</file>"

    // Layer 2 (specs/tool-output-chunking/, DD-2): token-aware bound.
    // Post-hoc check that's a no-op when natural output fits the budget
    // (INV-8: byte-identical to pre-Layer-2 behaviour for natural-fit
    // cases). Activates only when the existing line/byte caps weren't
    // tight enough (small-context models, or unusually high-density text).
    {
      const budget = ToolBudget.resolve(ctx, "read")
      const naturalTokens = ToolBudget.estimateTokens(output)
      if (naturalTokens > budget.tokens) {
        // Shrink content[] until output fits. Use binary-search style
        // exponential backoff for speed on large overruns.
        let kept = content.length
        let candidate = output
        while (kept > 0) {
          const prefix = "<file>\n" + content.slice(0, kept).join("\n")
          const newLastLine = offset + kept
          candidate =
            prefix +
            `\n\n(Output bounded at ~${budget.tokens} tokens by Layer 2 ` +
            `(${budget.source}). Use 'offset=${newLastLine}' to read beyond line ${newLastLine}.)\n</file>`
          if (ToolBudget.estimateTokens(candidate) <= budget.tokens) break
          kept = Math.max(0, Math.floor(kept * 0.85))
        }
        output = candidate
        hasMoreLines = true
      }
    }

    if (path.basename(filepath) === "SKILL.md") {
      output +=
        "\n\n<skill_advisory>\n" +
        "Reading of SKILL.md is detected.\n" +
        "If you intend to load a skill, use skill() instead, else just go ahead.\n" +
        "</skill_advisory>"
    }

    // just warms the lsp client
    LSP.touchFile(filepath, false)
    FileTime.read(ctx.sessionID, filepath)

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
      },
    }
  },
})

async function isBinaryFile(filepath: string, fileSize: number): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  if (fileSize === 0) return false

  const fh = await fs.promises.open(filepath, "r")
  try {
    const sampleSize = Math.min(4096, fileSize)
    const bytes = Buffer.alloc(sampleSize)
    const result = await fh.read(bytes, 0, sampleSize, 0)
    if (result.bytesRead === 0) return false

    let nonPrintableCount = 0
    for (let i = 0; i < result.bytesRead; i++) {
      if (bytes[i] === 0) return true
      if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
        nonPrintableCount++
      }
    }
    // If >30% non-printable characters, consider it binary
    return nonPrintableCount / result.bytesRead > 0.3
  } finally {
    await fh.close()
  }
}
