import path from "path"
import fs from "fs/promises"
import { homedir } from "os"
import { OPENAI_FALLBACK_MODELS } from "./model-curation"

const DEFAULTS: Record<string, string[]> = {
  "gemini-cli": ["gemini-2.0-flash", "gemini-2.0-flash-lite-preview-02-05", "gemini-2.0-pro-exp-02-05"],
  openai: OPENAI_FALLBACK_MODELS,
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
      // Ignore missing registry file
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
