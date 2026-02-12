import path from "path"
import os from "os"
import fs from "fs/promises"
import { pathToFileURL } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import { Instance } from "../project/instance"
import { Agent } from "../agent/agent"

export type ResolvedPromptPart =
  | {
      type: "text"
      text: string
    }
  | {
      type: "file"
      url: string
      filename: string
      mime: string
    }
  | {
      type: "agent"
      name: string
    }

export async function resolvePromptParts(template: string): Promise<ResolvedPromptPart[]> {
  const parts: ResolvedPromptPart[] = [
    {
      type: "text",
      text: template,
    },
  ]

  const matches = ConfigMarkdown.files(template)
  const seen = new Set<string>()
  const names = matches
    .map((match) => match[1])
    .filter((name) => {
      if (seen.has(name)) return false
      seen.add(name)
      return true
    })

  const resolved = await Promise.all(
    names.map(async (name) => {
      const filepath = name.startsWith("~/") ? path.join(os.homedir(), name.slice(2)) : path.resolve(Instance.worktree, name)

      const stats = await fs.stat(filepath).catch(() => undefined)
      if (!stats) {
        const agent = await Agent.get(name)
        if (!agent) return undefined
        return {
          type: "agent",
          name: agent.name,
        } as const
      }

      if (stats.isDirectory()) {
        return {
          type: "file",
          url: pathToFileURL(filepath).href,
          filename: name,
          mime: "application/x-directory",
        } as const
      }

      return {
        type: "file",
        url: pathToFileURL(filepath).href,
        filename: name,
        mime: "text/plain",
      } as const
    }),
  )

  for (const item of resolved) {
    if (!item) continue
    parts.push(item)
  }

  return parts
}
