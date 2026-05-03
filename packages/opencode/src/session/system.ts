import { Ripgrep } from "../file/ripgrep"
import { Instance } from "../project/instance"
import { Global } from "../global"
import path from "path"
import fs from "fs/promises"
import { existsSync, statSync } from "fs"

import PROMPT_CLAUDE_CODE from "./prompt/claude-code.txt"
import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_LEGACY from "./prompt/anthropic-20250930.txt"
import PROMPT_QWEN from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_PLAN from "./prompt/plan.txt"
import PROMPT_PLAN_REMINDER_ANTHROPIC from "./prompt/plan-reminder-anthropic.txt"
import PROMPT_MAX_STEPS from "./prompt/max-steps.txt"
import PROMPT_COPILOT_GPT5 from "./prompt/copilot-gpt-5.txt"
import PROMPT_ENABLEMENT from "./prompt/enablement.json"

import PROMPT_AGENT_CODING from "../agent/prompt/coding.txt"
import PROMPT_AGENT_REVIEW from "../agent/prompt/review.txt"
import PROMPT_AGENT_TESTING from "../agent/prompt/testing.txt"
import PROMPT_AGENT_DOCS from "../agent/prompt/docs.txt"
import PROMPT_AGENT_EXPLORE from "../agent/prompt/explore.txt"
import PROMPT_AGENT_COMPACTION from "../agent/prompt/compaction.txt"
import PROMPT_AGENT_SUMMARY from "../agent/prompt/summary.txt"
import PROMPT_AGENT_TITLE from "../agent/prompt/title.txt"
import PROMPT_AGENT_CRON from "../agent/prompt/cron.txt"
import PROMPT_AGENT_VISION from "../agent/prompt/vision.txt"
import PROMPT_AGENT_PDF_READER from "../agent/prompt/pdf-reader.txt"

import type { Provider } from "@/provider/provider"

/**
 * Built-in agent prompt registry.
 * Maps agent name → build-time imported content.
 * Used as fallback when no XDG override exists at ~/.config/opencode/prompts/agents/<name>.txt
 *
 * To add a new agent type:
 * 1. Create the prompt file: packages/opencode/src/agent/prompt/<name>.txt
 * 2. Import it above: import PROMPT_AGENT_XXX from "../agent/prompt/<name>.txt"
 * 3. Register it here: "<name>": PROMPT_AGENT_XXX
 * 4. Reference it in agent.ts getNativeAgents(): prompt: await SystemPrompt.agentPrompt("<name>")
 * 5. Run the app once — seedAll() will auto-create ~/.config/opencode/prompts/agents/<name>.txt
 */
const AGENT_PROMPTS: Record<string, string> = {
  coding: PROMPT_AGENT_CODING,
  review: PROMPT_AGENT_REVIEW,
  testing: PROMPT_AGENT_TESTING,
  docs: PROMPT_AGENT_DOCS,
  explore: PROMPT_AGENT_EXPLORE,
  compaction: PROMPT_AGENT_COMPACTION,
  summary: PROMPT_AGENT_SUMMARY,
  title: PROMPT_AGENT_TITLE,
  cron: PROMPT_AGENT_CRON,
  vision: PROMPT_AGENT_VISION,
  "pdf-reader": PROMPT_AGENT_PDF_READER,
}

export namespace SystemPrompt {
  // Cache for prompt contents: filename -> { content, mtime }
  const cache = new Map<string, { content: string; mtime: number }>()
  let seeded = false

  /**
   * Proactively seed all internal prompt assets to the user's config directory.
   * Optimized to run only once per process lifecycle.
   */
  export async function seedAll() {
    if (seeded) return
    seeded = true

    // Fire and forget seeding to avoid blocking the main thread
    seedInternal().catch((err) => console.error("Prompt seeding failed:", err))
  }

  async function seedInternal() {
    const assets: Record<string, string> = {
      "drivers/claude-code.txt": PROMPT_CLAUDE_CODE,
      "drivers/anthropic.txt": PROMPT_ANTHROPIC,
      "drivers/anthropic-legacy.txt": PROMPT_ANTHROPIC_LEGACY,
      "drivers/qwen.txt": PROMPT_QWEN,
      "drivers/beast.txt": PROMPT_BEAST,
      "drivers/gemini.txt": PROMPT_GEMINI,
      "drivers/trinity.txt": PROMPT_TRINITY,
      "drivers/codex.txt": PROMPT_CODEX,
      "drivers/gpt-5.txt": PROMPT_COPILOT_GPT5,
      "drivers/deepseek.txt": PROMPT_BEAST,
      "session/plan.txt": PROMPT_PLAN,
      "session/plan-reminder-anthropic.txt": PROMPT_PLAN_REMINDER_ANTHROPIC,
      "session/max-steps.txt": PROMPT_MAX_STEPS,
      "session/instructions.txt": PROMPT_CODEX.trim(),
      "enablement.json":
        typeof PROMPT_ENABLEMENT === "string" ? PROMPT_ENABLEMENT : JSON.stringify(PROMPT_ENABLEMENT, null, 2),
      // Agent prompts — XDG-managed for user customization
      ...Object.fromEntries(Object.entries(AGENT_PROMPTS).map(([name, content]) => [`agents/${name}.txt`, content])),
    }

    for (const [filename, content] of Object.entries(assets)) {
      const configPath = path.join(Global.Path.config, "prompts", filename)
      if (!existsSync(configPath)) {
        const dir = path.dirname(configPath)
        if (!existsSync(dir)) {
          await fs.mkdir(dir, { recursive: true })
        }
        await fs.writeFile(configPath, content, "utf-8")
      }
    }

    // Ensure default SYSTEM.md exists (default to main agent version for file creation)
    await system(false)
  }

  /**
   * Load a prompt from the user's config directory (~/.config/opencode/prompts/).
   * Uses in-memory caching with mtime check for performance.
   */
  async function loadPrompt(filename: string, internalContent: string): Promise<string> {
    const configPath = path.join(Global.Path.config, "prompts", filename)
    try {
      if (existsSync(configPath)) {
        // Check cache validity using mtime
        const stats = statSync(configPath)
        const cached = cache.get(filename)

        if (cached && cached.mtime === stats.mtimeMs) {
          return cached.content
        }

        const content = await fs.readFile(configPath, "utf-8")
        cache.set(filename, { content, mtime: stats.mtimeMs })
        return content
      }
      return internalContent
    } catch {
      return internalContent
    }
  }

  export async function instructions() {
    return loadPrompt("session/instructions.txt", PROMPT_CODEX.trim())
  }

  /**
   * Load the plan mode driver prompt from XDG config, falling back to built-in.
   * Path: ~/.config/opencode/prompts/session/plan.txt
   */
  export async function planPrompt() {
    return loadPrompt("session/plan.txt", PROMPT_PLAN)
  }

  /**
   * Load an agent prompt from XDG config, falling back to built-in content.
   * Path: ~/.config/opencode/prompts/agents/<name>.txt
   *
   * Returns undefined if the agent name has no registered prompt (e.g., "build", "plan", "general").
   */
  export async function agentPrompt(name: string): Promise<string | undefined> {
    const internal = AGENT_PROMPTS[name]
    if (!internal) return undefined
    return loadPrompt(`agents/${name}.txt`, internal)
  }

  export async function provider(model: Provider.Model): Promise<string[]> {
    // Proactively seed on first provider call to ensure visibility
    await seedAll()

    // Codex provider: single driver, same level as other providers
    if (model.providerId === "codex" || model.providerId.startsWith("codex-")) {
      return [await loadPrompt("drivers/codex.txt", PROMPT_CODEX)]
    }

    let internal = PROMPT_QWEN
    let name = "qwen"

    if (model.api.id.toLowerCase().includes("trinity")) {
      internal = PROMPT_TRINITY
      name = "trinity"
    } else if (model.api.id.includes("gpt-5")) {
      internal = PROMPT_COPILOT_GPT5
      name = "gpt-5"
    } else if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3")) {
      internal = PROMPT_BEAST
      name = "beast"
    } else if (model.api.id.includes("gemini-")) {
      internal = PROMPT_GEMINI
      name = "gemini"
    } else if (model.api.id.includes("claude")) {
      internal = PROMPT_CLAUDE_CODE
      name = "claude-code"
    } else if (model.api.id.toLowerCase().includes("deepseek")) {
      internal = PROMPT_BEAST
      name = "deepseek"
    }

    return [await loadPrompt(`drivers/${name}.txt`, internal)]
  }

  /**
   * Load the Core System Prompt from SYSTEM.md (SSOT).
   * SYSTEM.md contains all operational rules including role-specific protocols.
   * Role detection is based on Parent Session ID in the environment context.
   *
   * The isSubagent parameter is kept for seed-time file creation only.
   * At runtime, SYSTEM.md is loaded as-is — role switching happens via env context.
   */
  export async function system(isSubagent: boolean): Promise<string[]> {
    // Minimal fallback if SYSTEM.md doesn't exist yet (first boot / seed)
    const fallback = `# Operational SYSTEM
You are an AI assistant. Check Parent Session ID: "none" = orchestrator (delegate via task()), otherwise = worker (execute assigned task).
Absolute paths only. Read before write. Concise responses.`

    return [await loadPrompt("SYSTEM.md", fallback)]
  }

  export async function environment(model: Provider.Model, sessionID: string, parentID?: string) {
    const split = await environmentParts(model, sessionID, parentID)
    return [`${split.baseEnv}\n  Today's date: ${split.todaysDate}\n</env>\n<directories>\n  \n</directories>`]
  }

  /**
   * Phase B B.2.2 (DD-2): structured environment split. baseEnv carries the
   * session-scoped fields (model id, session ids, cwd, vcs, platform) — all
   * stable within a session. todaysDate is the only daily-mutating field;
   * keeping it separate lets the preface builder place it last in T1 so
   * cross-day cache invalidation only affects content after the date marker.
   */
  export async function environmentParts(
    model: Provider.Model,
    sessionID: string,
    parentID?: string,
  ): Promise<{ baseEnv: string; todaysDate: string }> {
    const project = Instance.project
    const baseEnv = [
      `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerId}/${model.api.id}`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Session ID: ${sessionID}`,
      `  Parent Session ID: ${parentID ?? "none (Main Session)"}`,
      `  Working directory: ${Instance.directory}`,
      `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
    ].join("\n")
    return { baseEnv, todaysDate: new Date().toDateString() }
  }
}
