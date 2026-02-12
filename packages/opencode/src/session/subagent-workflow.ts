import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { iife } from "@/util/iife"
import { MessageV2 } from "./message-v2"
import { Config } from "../config/config"

export const WORKFLOW_KEYWORDS = [
  "分工",
  "多代理",
  "multi-agent",
  "subagent",
  "review",
  "檢查",
  "檢視",
  "測試",
  "test",
  "testing",
]

export const WORKFLOW_ROLES = ["explore", "coding", "review", "testing", "docs"]
export const WORKFLOW_MIN_CHARS = 160
export const WORKFLOW_MIN_LINES = 3

const WORKFLOW_MODEL_FALLBACKS: Record<string, string[]> = {
  explore: ["gemini-cli/gemini-2.5-flash", "openai/gpt-5.2", "openai/gpt-5.2-codex"],
  coding: ["openai/gpt-5.2-codex", "openai/gpt-5.2", "gemini-cli/gemini-2.5-pro"],
  review: ["gemini-cli/gemini-2.5-pro", "openai/gpt-5.2", "openai/gpt-5.2-codex"],
  testing: ["openai/gpt-5.2-codex", "openai/gpt-5.2", "gemini-cli/gemini-2.5-flash"],
  docs: ["openai/gpt-5.2", "gemini-cli/gemini-2.5-pro", "openai/gpt-5.2-codex"],
}

export type WorkflowSubtaskDraft = Pick<MessageV2.SubtaskPart, "type" | "agent" | "description" | "prompt" | "model">

function rolePrompt(role: string, text: string) {
  if (role === "explore")
    return "Explore the codebase for relevant files, existing patterns, and constraints. Summarize findings.\n\nUser request:\n" + text
  if (role === "coding") return "Propose an implementation plan and key code changes.\n\nUser request:\n" + text
  if (role === "review") return "Identify correctness risks, edge cases, and potential regressions.\n\nUser request:\n" + text
  if (role === "testing") return "Suggest a focused test/verification plan.\n\nUser request:\n" + text
  if (role === "docs") return "List documentation or changelog updates needed.\n\nUser request:\n" + text
  return "Provide a concise subtask response.\n\nUser request:\n" + text
}

type WorkflowInputPart = {
  type: string
  mime?: string
  text?: string
}

export async function maybeInjectWorkflowSubtasks(input: {
  parts: WorkflowInputPart[]
  agent: Agent.Info
  noReply?: boolean
}) {
  if (input.agent.mode === "subagent") return input.parts
  if (input.noReply) return input.parts
  if (input.parts.some((part) => part.type === "subtask" || part.type === "agent")) return input.parts
  const hasImage = input.parts.some((part) => part.type === "file" && part.mime?.startsWith("image/"))
  if (hasImage) return input.parts

  const cfg = await Config.get()
  const workflow = cfg.experimental?.subagent_workflow
  if (workflow?.enabled !== true) return input.parts

  const text = input.parts
    .filter((part: WorkflowInputPart) => part.type === "text")
    .map((part: WorkflowInputPart) => part.text ?? "")
    .join("\n\n")
    .trim()
  if (!text) return input.parts

  const keywords = workflow?.keywords ?? WORKFLOW_KEYWORDS
  const roles = workflow?.roles ?? WORKFLOW_ROLES
  const minChars = workflow?.min_chars ?? WORKFLOW_MIN_CHARS
  const minLines = workflow?.min_lines ?? WORKFLOW_MIN_LINES
  const normalized = text.toLowerCase()
  const hasKeyword = keywords.some((keyword) => keyword && normalized.includes(keyword.toLowerCase()))
  const lines = text.split(/\r?\n/).filter((line: string) => line.trim().length > 0)
  const hasList = /(^|\n)\s*[-*]\s+/.test(text) || /(^|\n)\s*\d+\.\s+/.test(text)
  const hasFiles = input.parts.some((part: WorkflowInputPart) => part.type === "file")
  const nonTrivial = text.length >= minChars || lines.length >= minLines || hasList || hasFiles || input.parts.length > 1
  if (!hasKeyword && !nonTrivial) return input.parts

  const overrides = workflow?.models ?? {}
  const tasks = await buildWorkflowSubtasks({
    text,
    roles,
    overrides,
  })

  if (tasks.length === 0) return input.parts
  return [...tasks.reverse(), ...input.parts]
}

export async function buildWorkflowSubtasks(input: {
  text: string
  roles: string[]
  overrides: Record<string, string>
}): Promise<WorkflowSubtaskDraft[]> {
  const providers = await Provider.list()
  const { ModelScoring } = await import("../agent/score")
  const tasks: WorkflowSubtaskDraft[] = []

  for (const role of input.roles) {
    const sub = await Agent.get(role)
    if (!sub) continue

    const override = input.overrides[role]
    const model = await iife(async () => {
      if (override) {
        const parsed = Provider.parseModel(override)
        if (providers[parsed.providerId]?.models?.[parsed.modelID]) return parsed
      }

      if (sub.model && providers[sub.model.providerId]?.models?.[sub.model.modelID]) return sub.model

      const scored = await ModelScoring.select(role)
      if (scored) return scored

      const fallbacks = WORKFLOW_MODEL_FALLBACKS[role] ?? []
      for (const candidate of fallbacks) {
        const parsed = Provider.parseModel(candidate)
        if (providers[parsed.providerId]?.models?.[parsed.modelID]) return parsed
      }

      return undefined
    })

    tasks.push({
      type: "subtask",
      agent: sub.name,
      description: `Auto ${role} task`,
      prompt: rolePrompt(role, input.text),
      ...(model ? { model } : {}),
    })
  }

  return tasks
}
