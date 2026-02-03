import path from "path"
import fs from "fs/promises"
import { homedir } from "os"

// Default models seed matching verified user list
const DEFAULTS: Record<string, string[]> = {
  antigravity: [
    "claude-opus-4-5-thinking",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-thinking",
    "gpt-oss-120b-medium",
    "gemini-3-flash",
    "gemini-3-pro-high",
    "gemini-3-pro-low",
  ],
  "gemini-cli": [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3-pro-preview",
  ],
  openai: ["gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex"],
}

export class ModelRegistry {
  private configPath: string
  private models: Record<string, string[]> = {}

  constructor() {
    this.configPath = path.join(homedir(), ".config", "opencode", "models.json")
    this.models = JSON.parse(JSON.stringify(DEFAULTS))
  }

  async load() {
    try {
      const data = await fs.readFile(this.configPath, "utf-8")
      const custom = JSON.parse(data)
      for (const [provider, list] of Object.entries(custom)) {
        if (Array.isArray(list)) {
          this.models[provider] = list as string[]
        }
      }
    } catch {
      // Ignore error if file doesn't exist
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true })
    await fs.writeFile(this.configPath, JSON.stringify(this.models, null, 2))
  }

  get(provider: string): string[] {
    return this.models[provider] || []
  }

  add(provider: string, model: string) {
    if (!this.models[provider]) this.models[provider] = []
    if (!this.models[provider].includes(model)) {
      this.models[provider].push(model)
      this.models[provider].sort()
    }
  }

  remove(provider: string, model: string) {
    if (!this.models[provider]) return
    this.models[provider] = this.models[provider].filter((m) => m !== model)
  }

  reset(provider: string) {
    if (DEFAULTS[provider]) {
      this.models[provider] = [...DEFAULTS[provider]]
    } else {
      delete this.models[provider]
    }
  }
}

export const modelRegistry = new ModelRegistry()
