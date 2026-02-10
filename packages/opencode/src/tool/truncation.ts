import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { Identifier } from "../id/id"
import { PermissionNext } from "../permission/next"
import type { Agent } from "../agent/agent"
import { Scheduler } from "../scheduler"
import { Storage } from "../storage/storage"

export namespace Truncate {
  export const MAX_LINES = 2000
  export const MAX_BYTES = 256 * 1024
  // @event_2026-02-11_session_storage_unify:
  // Store truncated outputs under each session folder:
  // storage/session/<project>/<session>/output/output_tool_*
  export const DIR = path.join(Global.Path.data, "storage", "session")
  export const GLOB = path.join(DIR, "*")
  const RETENTION_MS = 24 * 60 * 60 * 1000 // 24 hours
  const HOUR_MS = 60 * 60 * 1000

  export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

  export interface Options {
    maxLines?: number
    maxBytes?: number
    direction?: "head" | "tail"
  }

  export function init() {
    Scheduler.register({
      id: "tool.truncation.cleanup",
      interval: HOUR_MS,
      run: cleanup,
      scope: "global",
    })
  }

  export async function cleanup() {
    const cutoff = Identifier.timestamp(Identifier.create("tool", false, Date.now() - RETENTION_MS))
    const glob = new Bun.Glob("**/output/output_*")
    const entries = await Array.fromAsync(glob.scan({ cwd: DIR, onlyFiles: true })).catch(() => [] as string[])
    for (const entry of entries) {
      const filename = path.basename(entry)
      const identifier = filename.startsWith("output_") ? filename.slice("output_".length) : filename
      if (Identifier.timestamp(identifier) >= cutoff) continue
      await fs.unlink(path.join(DIR, entry)).catch(() => {})
    }

    // Clean up empty output directories
    const outputDirs = await Array.fromAsync(new Bun.Glob("**/output").scan({ cwd: DIR, onlyFiles: false })).catch(
      () => [] as string[],
    )
    for (const dir of outputDirs) {
      const fullPath = path.join(DIR, dir)
      const files = await fs.readdir(fullPath).catch(() => [])
      if (files.length === 0) {
        await fs.rmdir(fullPath).catch(() => {})
      }
    }
  }

  function hasTaskTool(agent?: Agent.Info): boolean {
    if (!agent?.permission) return false
    const rule = PermissionNext.evaluate("task", "*", agent.permission)
    return rule.action !== "deny"
  }

  export async function output(
    text: string,
    options: Options = {},
    agent?: Agent.Info,
    sessionID?: string,
  ): Promise<Result> {
    const maxLines = options.maxLines ?? MAX_LINES
    const maxBytes = options.maxBytes ?? MAX_BYTES
    const direction = options.direction ?? "head"
    const lines = text.split("\n")
    const totalBytes = Buffer.byteLength(text, "utf-8")

    if (lines.length <= maxLines && totalBytes <= maxBytes) {
      return { content: text, truncated: false }
    }

    const out: string[] = []
    let i = 0
    let bytes = 0
    let hitBytes = false

    if (direction === "head") {
      for (i = 0; i < lines.length && i < maxLines; i++) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.push(lines[i])
        bytes += size
      }
    } else {
      for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.unshift(lines[i])
        bytes += size
      }
    }

    const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
    const unit = hitBytes ? "bytes" : "lines"
    const preview = out.join("\n")

    const id = Identifier.ascending("tool")
    const outputName = `output_${id}`
    const sessionDir = sessionID ? await Storage.sessionDirectory(sessionID) : undefined
    const dir = sessionDir ? path.join(sessionDir, "output") : path.join(Global.Path.data, "storage", "output")
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    const filepath = path.join(dir, outputName)
    await Bun.write(Bun.file(filepath), text)

    const hint = hasTaskTool(agent)
      ? `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
      : `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
    const message =
      direction === "head"
        ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
        : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`

    return { content: message, truncated: true, outputPath: filepath }
  }
}
