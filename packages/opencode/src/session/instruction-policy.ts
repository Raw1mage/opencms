import { InstructionPrompt } from "./instruction"
import { Instance } from "../project/instance"
import z from "zod"

export type RotationPriorityRule = {
  providerId: string
  accountId?: string
  modelID?: string
  providerTokens?: string[]
  accountTokens?: string[]
  modelTokens?: string[]
}

export type RotationPriorityPolicy = {
  rules: RotationPriorityRule[]
  providerPriority?: string[]
}

function normalizeWildcard(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed === "*") return undefined
  return trimmed
}

function normalizeTokens(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
  if (!normalized) return undefined
  const tokens = normalized.split(" ").filter(Boolean)
  return tokens.length ? tokens : undefined
}

export function parseRotationPriorityText(text: string): RotationPriorityPolicy | undefined {
  const headerMatch = text.match(/rotation\s+priority\s+preference\s+by\s*\(provider,\s*account,\s*model\)/i)
  if (!headerMatch) return undefined

  const lines = text.split("\n")
  const headerIndex = lines.findIndex((line) =>
    /rotation\s+priority\s+preference\s+by\s*\(provider,\s*account,\s*model\)/i.test(line),
  )
  if (headerIndex < 0) return undefined

  const rules: RotationPriorityRule[] = []
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (/^[-]{3,}/.test(line)) break
    if (/^end\b/i.test(line)) break

    const match = line.match(/^\d+\s*\.\s*\(([^)]*)\)/)
    if (!match) continue
    const parts = match[1].split(",").map((p) => p.trim())
    if (parts.length < 1) continue

    const providerId = normalizeWildcard(parts[0])
    if (!providerId) continue
    const accountId = normalizeWildcard(parts[1])
    const modelID = normalizeWildcard(parts[2])

    rules.push({
      providerId,
      accountId,
      modelID,
      providerTokens: normalizeTokens(providerId),
      accountTokens: normalizeTokens(accountId),
      modelTokens: normalizeTokens(modelID),
    })
  }

  if (rules.length === 0) return undefined

  const providerPriority: string[] = []
  for (const rule of rules) {
    if (!providerPriority.includes(rule.providerId)) {
      providerPriority.push(rule.providerId)
    }
  }

  return { rules, providerPriority }
}

export async function loadInstructionBlock(blockName: string): Promise<{ raw: string; source: string } | undefined> {
  const paths = await InstructionPrompt.systemPaths()
  const list = Array.from(paths).filter((p) => p.endsWith("AGENTS.md"))
  const root = Instance.worktree
  const order = list.toSorted((a, b) => {
    const aLocal = a.startsWith(root) ? 0 : 1
    const bLocal = b.startsWith(root) ? 0 : 1
    if (aLocal !== bLocal) return aLocal - bLocal
    return a.localeCompare(b)
  })

  for (const item of order) {
    const text = await Bun.file(item)
      .text()
      .catch(() => "")
    if (!text) continue
    const match = text.match(
      new RegExp("```" + blockName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&") + "\\s*([\\s\\S]*?)```", "m"),
    )
    if (!match) continue
    const raw = match[1]?.trim()
    if (!raw) continue
    return { raw, source: item }
  }
}

export async function loadInstructionJSON<T>(blockName: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const block = await loadInstructionBlock(blockName)
  if (!block) return undefined
  let json: unknown
  try {
    json = JSON.parse(block.raw)
  } catch {
    return undefined
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) return undefined
  return parsed.data
}
