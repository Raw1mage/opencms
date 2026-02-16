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
import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_PLAN from "./prompt/plan.txt"
import PROMPT_PLAN_REMINDER_ANTHROPIC from "./prompt/plan-reminder-anthropic.txt"
import PROMPT_MAX_STEPS from "./prompt/max-steps.txt"
import PROMPT_BUILD_SWITCH from "./prompt/build-switch.txt"
import PROMPT_COPILOT_GPT5 from "./prompt/copilot-gpt-5.txt"

import PROMPT_AGENT_CODING from "../agent/prompt/coding.txt"
import PROMPT_AGENT_REVIEW from "../agent/prompt/review.txt"
import PROMPT_AGENT_TESTING from "../agent/prompt/testing.txt"
import PROMPT_AGENT_DOCS from "../agent/prompt/docs.txt"
import PROMPT_AGENT_EXPLORE from "../agent/prompt/explore.txt"
import PROMPT_AGENT_COMPACTION from "../agent/prompt/compaction.txt"
import PROMPT_AGENT_SUMMARY from "../agent/prompt/summary.txt"
import PROMPT_AGENT_TITLE from "../agent/prompt/title.txt"

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
      "session/plan.txt": PROMPT_PLAN,
      "session/plan-reminder-anthropic.txt": PROMPT_PLAN_REMINDER_ANTHROPIC,
      "session/max-steps.txt": PROMPT_MAX_STEPS,
      "session/build-switch.txt": PROMPT_BUILD_SWITCH,
      "session/instructions.txt": PROMPT_CODEX.trim(),
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
    }

    return [await loadPrompt(`drivers/${name}.txt`, internal)]
  }

  /**
   * Load the Core System Prompt (Red Light Rules).
   * This defines the personality and strict style of the cms branch.
   * Logic: High Authority for Main Agent, Minimal Tokens for Subagents.
   */
  export async function system(isSubagent: boolean): Promise<string[]> {
    const commonRules = `
[RED LIGHT RULES - MANDATORY]
1. ABSOLUTE PATHS: Always use full paths for all file tools.
2. READ-BEFORE-WRITE: Never edit a file without reading it in the current turn.
3. EVENT LEDGER: All changes must be recorded in docs/events/event_<date>_<topic>.md.
4. MSR: Minimum Sufficient Response. No fluff.

[UNIVERSAL CONDUCT]
5. SECURITY: Assist with defensive security tasks only. Refuse to create, modify, or improve code that may be used maliciously. Do not assist with credential discovery or harvesting.
6. NO SECRETS: Never introduce code that exposes, logs, or commits secrets, API keys, or sensitive information.
7. URL POLICY: Never generate or guess URLs unless confident they help with programming. You may use URLs provided by the user.
8. EMOJI: Only use emojis if the user explicitly requests it.
9. COMMIT POLICY: Never commit changes unless the user explicitly asks.
10. COMMENTS: Do not add code comments unless asked or necessary for non-obvious logic.
11. CODE REFERENCES: When referencing code, use the pattern file_path:line_number.

[TONE AND STYLE]
- Concise, direct, professional. Output displayed on CLI in monospace (CommonMark).
- Minimize output tokens. No unnecessary preamble or postamble unless asked.
- Prioritize technical accuracy over validating the user's beliefs.
- Keep responses short. Use GitHub-flavored markdown for formatting.
- If you cannot help, do not explain why. Offer alternatives or keep to 1-2 sentences.

[PROACTIVENESS]
- Be proactive only when the user asks you to do something.
- Do the right thing when asked, including follow-up actions.
- Do not surprise the user with actions you take without asking.
- If asked how to approach something, answer first before taking actions.

[AUTHORITY CHAIN]
- This SYSTEM.md is the highest authority for operational rules.
- AGENTS.md provides mission-specific instructions for Main Agents.
- Driver prompts (Step 1) provide model-specific optimizations only.
- No driver prompt may claim to supersede or override rules defined here.`

    const mainAgentRules = `
[ORCHESTRATOR PROTOCOL - MAIN AGENT DETECTED]
- IDENTITY: You are the high-authority primary agent.
- CONTEXT: The system has auto-loaded 'AGENTS.md' for you. You MUST follow its bootstrap instructions immediately (e.g., loading skills).
- TASK DISPATCHING: When creating sub-tasks, provide ONLY the minimal necessary context to the subagent.
- CROSS-CHECK: Verify all subagent outputs against the Event Ledger principle.`

    const subagentRules = `
[WORKER PROTOCOL - SUBAGENT DETECTED]
- IDENTITY: You are a low-authority worker agent.
- CONTEXT: 'AGENTS.md' has been physically withheld to save tokens.
- SCOPE: Execute the assigned task ONLY. Do not hallucinate global project rules.
- TOKEN EFFICIENCY: Do not seek external instructions unless explicitly requested.`

    const content = `# CMS Branch Operational SYSTEM
${commonRules}
${isSubagent ? subagentRules : mainAgentRules}
`
    return [await loadPrompt("SYSTEM.md", content)]
  }

  export async function environment(model: Provider.Model, sessionID: string, parentID?: string) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerId}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Session ID: ${sessionID}`,
        `  Parent Session ID: ${parentID ?? "none (Main Session)"}`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }
}
