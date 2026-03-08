import type { Argv } from "yargs"
import { Instance } from "../../project/instance"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { modelRegistry } from "../../provider/model-registry"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { EOL } from "os"
import { Account } from "../../account"
import { OPENAI_FALLBACK_MODELS } from "../../provider/model-curation"

// Define specific models for Gemini CLI as fallback
const GEMINI_CLI_MODELS = [
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
]

// Define specific models for OpenAI as fallback
const OPENAI_MODELS = OPENAI_FALLBACK_MODELS

// Internal ID to Display Name
const DISPLAY_ALIASES: Record<string, string> = {}

// Input Name to Internal ID
const INPUT_ALIASES: Record<string, string> = {}

export const ModelsCommand = cmd({
  command: "models [action] [provider] [model]",
  describe: "Manage and monitor models. Actions: list (default), add, remove, reset.",
  builder: (yargs: Argv) => {
    return yargs
      .positional("action", {
        describe: "Action to perform (add, remove, reset) or Provider ID to filter by",
        type: "string",
      })
      .positional("provider", {
        describe: "Provider ID (for add/remove actions)",
        type: "string",
      })
      .positional("model", {
        describe: "Model ID (for add/remove actions)",
        type: "string",
      })
      .option("verbose", {
        describe: "use more verbose model output",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev AND Google API",
        type: "boolean",
      })
      .example("opencode models", "Show status dashboard")
      .example("opencode models add google-api gemini-1.5-pro", "Add model using simplified alias")
  },
  handler: async (args) => {
    // Determine mode
    let mode: "list" | "add" | "remove" | "reset" = "list"
    let filterProvider: string | undefined = undefined

    // Resolve aliases for inputs
    let targetProvider = args.provider
    if (targetProvider && INPUT_ALIASES[targetProvider]) {
      targetProvider = INPUT_ALIASES[targetProvider]
    }

    let targetModel = args.model

    const action = args.action?.toLowerCase()

    if (action === "add" || action === "remove" || action === "reset") {
      mode = action
    } else if (action) {
      // Treat as provider filter (also check alias)
      filterProvider = INPUT_ALIASES[action] || action
    }

    if (args.refresh) {
      await ModelsDev.refresh()
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    // Load registry
    await modelRegistry.load()

    if (args.refresh) {
      UI.println("Refreshing model lists...")

      // 1. Refresh generic cache
      await ModelsDev.refresh()
      UI.println("  • Models.dev cache refreshed")

      // 2. Discover Google API models
      try {
        const families = await Account.listAll()
        // Look for google-api accounts
        const googleFamily = families["google-api"]
        if (googleFamily && googleFamily.accounts) {
          const accounts = Object.values(googleFamily.accounts)
          // Find first account with apiKey
          const acc = accounts.find((a): a is Account.ApiAccount => a.type === "api")
          if (acc) {
            const apiKey = acc.apiKey
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
            if (response.ok) {
              const data = await response.json()
              if (data.models && Array.isArray(data.models)) {
                let count = 0
                for (const m of data.models) {
                  let name = m.name
                  if (name.startsWith("models/")) name = name.substring(7)
                  if (name.includes("gemini") || name.includes("palm")) {
                    modelRegistry.add("google-api", name)
                    count++
                  }
                }
                await modelRegistry.save()
                UI.println(`  • Discovered ${count} Google models via API`)
              }
            } else {
              UI.println(`  • Failed to list Google models: ${response.status}`)
            }
          }
        }
      } catch (e) {
        UI.println(`  • Error refreshing Google models: ${e}`)
      }

      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Refresh complete." + UI.Style.TEXT_NORMAL)
    }

    // Handle modification actions
    if (mode !== "list") {
      if (!targetProvider) {
        UI.error(`Provider required for ${mode}. Usage: opencode models ${mode} <provider> [model]`)
        return
      }

      const displayProvider = DISPLAY_ALIASES[targetProvider] || targetProvider

      if (mode === "add" && targetModel) {
        modelRegistry.add(targetProvider, targetModel)
        await modelRegistry.save()
        UI.println(UI.Style.TEXT_SUCCESS + `Added ${targetModel} to ${displayProvider}` + UI.Style.TEXT_NORMAL)
        return
      }

      if (mode === "remove" && targetModel) {
        modelRegistry.remove(targetProvider, targetModel)
        await modelRegistry.save()
        UI.println(UI.Style.TEXT_SUCCESS + `Removed ${targetModel} from ${displayProvider}` + UI.Style.TEXT_NORMAL)
        return
      }

      if (mode === "reset") {
        modelRegistry.reset(targetProvider)
        await modelRegistry.save()
        UI.println(UI.Style.TEXT_SUCCESS + `Reset ${displayProvider} to defaults` + UI.Style.TEXT_NORMAL)
        return
      }

      UI.error("Missing arguments.")
      return
    }

    // List Mode (Dashboard)
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const families = await Account.listAll()
        const providers = await Provider.list()
        const now = Date.now()

        // Helper for time formatting
        const getWaitTime = (ts: number | undefined) => {
          if (!ts || ts <= now) return null
          const waitSec = Math.ceil((ts - now) / 1000)
          if (waitSec > 3600) return `${(waitSec / 3600).toFixed(1)}h`
          if (waitSec > 60) return `${(waitSec / 60).toFixed(1)}m`
          return `${waitSec}s`
        }

        // Order providers
        const order = ["gemini-cli", "claude-cli", "openai", "opencode", "google-api"]
        const sortedFamilies = Object.keys(families).sort((a, b) => {
          // Map a to sort key if needed, mostly 'google-api' is in sort list
          const idxA = order.indexOf(a)
          const idxB = order.indexOf(b)
          if (idxA === -1 && idxB === -1) return a.localeCompare(b)
          if (idxA === -1) return 1
          if (idxB === -1) return -1
          return idxA - idxB
        })

        console.log(UI.Style.TEXT_NORMAL_BOLD + "\n📦 Model Health & Availability Status\n" + UI.Style.TEXT_NORMAL)

        for (const familyName of sortedFamilies) {
          if (filterProvider && filterProvider !== familyName) continue

          const familyData = families[familyName]
          const accountsArr = Object.entries(familyData.accounts)

          if (accountsArr.length === 0) continue

          // Apply alias for display
          const displayFamilyName = Account.getProviderLabel(familyName)

          console.log(UI.Style.TEXT_HIGHLIGHT_BOLD + `📂 ${displayFamilyName.toUpperCase()}` + UI.Style.TEXT_NORMAL)

          for (const [id, info] of accountsArr) {
            const isActive = familyData.activeAccount === id
            const activeMark = isActive ? UI.Style.TEXT_SUCCESS + "●" + UI.Style.TEXT_NORMAL : "○"

            // 2. Determine Display Name
            const displayName = Account.getDisplayName(id, info, familyName)

            console.log(`  ${activeMark} 👤 ${displayName}`)

            // Determine available models using Registry
            let modelsToShow: string[] = []

            // Try to get from registry first for ALL providers
            const customList = modelRegistry.get(familyName)

            if (customList.length > 0) {
              modelsToShow = [...customList]
            } else {
              // Fallback if not in registry
              if (familyName === "gemini-cli") {
                modelsToShow = GEMINI_CLI_MODELS
              } else if (familyName === "openai") {
                modelsToShow = OPENAI_MODELS
              } else {
                const p = providers[familyName]
                if (p) {
                  modelsToShow = Object.keys(p.models).slice(0, 6)
                } else {
                  modelsToShow = ["standard-model"]
                }
              }
            }

            // Sort models
            modelsToShow.sort()

            for (const model of modelsToShow) {
              let status = "✅ Ready"

              if (familyName === "gemini-cli") {
                const accountInfo = info as any
                let wait = null
                if (accountInfo.rateLimitResetTimes) {
                  wait = getWaitTime(accountInfo.rateLimitResetTimes["gemini-cli"])
                }
                if (!wait && accountInfo.coolingDownUntil && accountInfo.coolingDownUntil > now) {
                  wait = getWaitTime(accountInfo.coolingDownUntil)
                }
                if (wait) status = `⏳ Limit (${wait})`
              }

              console.log(`      • ${model.padEnd(30)} : ${status}`)
            }
            console.log("")
          }
          console.log("")
        }

        console.log(UI.Style.TEXT_DIM + `Last updated: ${new Date().toLocaleTimeString()}` + UI.Style.TEXT_NORMAL)

        if (!args.refresh) {
          console.log(
            UI.Style.TEXT_DIM +
              `Hint: Use 'opencode models --refresh' to discover new Google models.` +
              UI.Style.TEXT_NORMAL,
          )
        }
      },
    })
  },
})
