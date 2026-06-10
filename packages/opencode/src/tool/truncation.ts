import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { Identifier } from "../id/id"
import { PermissionNext } from "../permission/next"
import type { Agent } from "../agent/agent"
import { Scheduler } from "../scheduler"
import { Storage } from "../storage/storage"
import { ToolBudget } from "./budget"

export namespace Truncate {
  export const MAX_LINES = 2000
  export const MAX_BYTES = 256 * 1024
  // session_tool-output-redirection DD-1/DD-3: the externalization decision is in
  // TOKENS (the context-budget currency), not bytes; and when a result IS
  // externalized the inline preview is a SMALL token-bounded head/tail (not the
  // old byte-capped near-full preview that left a redirected result still huge in
  // the prompt every turn). The full body lives in the output file (the handle);
  // PREVIEW_TOKENS is what stays inline.
  export const PREVIEW_TOKENS = 600
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
    /** Externalization gate in TOKENS (DD-1). Defaults to the ToolBudget cap. */
    maxTokens?: number
    /** Inline preview size in TOKENS when externalizing (DD-3). Default PREVIEW_TOKENS. */
    previewTokens?: number
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
    // DD-1: externalization gate is in TOKENS (ToolBudget cap, default 50K), not
    // bytes. maxBytes is retained only as an explicit per-call override.
    const maxTokens = options.maxTokens ?? ToolBudget.resolve({ outputBudget: undefined }).tokens
    const previewTokens = options.previewTokens ?? PREVIEW_TOKENS
    const direction = options.direction ?? "head"
    const lines = text.split("\n")
    const totalTokens = ToolBudget.estimateTokens(text)

    // Behaviour-preserving for small results: inline unchanged.
    if (lines.length <= maxLines && totalTokens <= maxTokens) {
      return { content: text, truncated: false }
    }

    // DD-3: the inline preview is a SMALL token-bounded head/tail. The full body
    // goes to the output file (the handle); only PREVIEW_TOKENS stays in the prompt.
    const out: string[] = []
    let i = 0
    let toks = 0
    let hitCap = false

    if (direction === "head") {
      for (i = 0; i < lines.length && i < maxLines; i++) {
        const size = ToolBudget.estimateTokens(lines[i]) + (i > 0 ? 1 : 0)
        if (toks + size > previewTokens) {
          hitCap = true
          break
        }
        out.push(lines[i])
        toks += size
      }
    } else {
      for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
        const size = ToolBudget.estimateTokens(lines[i]) + (out.length > 0 ? 1 : 0)
        if (toks + size > previewTokens) {
          hitCap = true
          break
        }
        out.unshift(lines[i])
        toks += size
      }
    }

    const removed = hitCap ? totalTokens - toks : lines.length - out.length
    const unit = hitCap ? "tokens" : "lines"
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
